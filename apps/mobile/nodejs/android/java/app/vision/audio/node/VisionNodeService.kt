package app.vision.audio.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import org.json.JSONObject

/**
 * Держит Node-рантайм и HTTP-сервер в отдельном Android-процессе.
 *
 * `android:process=":vision_node"` важен не только для фоновой работы: C++/V8
 * могут завершить процесс при фатальной ошибке. Благодаря отдельному процессу
 * при этом закрывается только сервер, а UI и плеер продолжают работать.
 */
class VisionNodeService : Service() {
    @Volatile
    private var nodeThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val dataDir = intent?.getStringExtra(EXTRA_DATA_DIR) ?: ServerRunner.dataDir(this)
        val port = intent?.getIntExtra(EXTRA_PORT, DEFAULT_PORT) ?: DEFAULT_PORT
        val arguments = intent?.getStringArrayListExtra(EXTRA_ARGUMENTS)?.toTypedArray()

        try {
            // Android требует показать уведомление до любой долгой работы сервиса.
            startForeground(NOTIFICATION_ID, notification())
        } catch (error: Throwable) {
            ServerRunner.writeFailure(dataDir, port, "Не удалось запустить foreground-сервис: ${error.message ?: error}")
            stopSelf(startId)
            return START_NOT_STICKY
        }

        if (arguments.isNullOrEmpty()) {
            ServerRunner.writeFailure(dataDir, port, "Сервис запущен без аргументов Node")
            stopSelf(startId)
            return START_NOT_STICKY
        }

        synchronized(this) {
            // Повторный Intent во время запуска не должен поднимать второй Node.
            if (nodeThread?.isAlive != true) {
                nodeThread = Thread({
                    try {
                        // Не выводим argv целиком: в нём может быть токен API.
                        Log.i("VisionNode", "Запуск Node в отдельном процессе на порту $port")
                        val code = NodeRuntime.start(arguments, true)
                        Log.i("VisionNode", "Node завершился с кодом $code")
                        ServerRunner.markUnexpectedExit(dataDir, port, code)
                    } catch (error: Throwable) {
                        Log.e("VisionNode", "Node не запустился", error)
                        ServerRunner.writeFailure(dataDir, port, error.message ?: error.javaClass.simpleName)
                    } finally {
                        stopSelf()
                    }
                }, "vision-node").also { it.start() }
            }
        }

        // START_NOT_STICKY: если ОС убьёт сервис, он не поднимется без запроса UI.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Сервер на телефоне",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Пока сервер запущен, приложение доступно по адресу на устройстве" }
            manager.createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Vision Audio — сервер работает")
            .setContentText("HTTP-сервер запущен на этом телефоне")
            .setSmallIcon(android.R.drawable.stat_sys_headset)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "vision-node"
        private const val NOTIFICATION_ID = 4711
        private const val DEFAULT_PORT = 4000
        private const val EXTRA_ARGUMENTS = "vision.node.arguments"
        private const val EXTRA_DATA_DIR = "vision.node.dataDir"
        private const val EXTRA_PORT = "vision.node.port"

        fun start(context: Context, arguments: Array<String>, port: Int, dataDir: String) {
            val intent = Intent(context, VisionNodeService::class.java).apply {
                putStringArrayListExtra(EXTRA_ARGUMENTS, ArrayList(arguments.toList()))
                putExtra(EXTRA_DATA_DIR, dataDir)
                putExtra(EXTRA_PORT, port)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VisionNodeService::class.java))
        }
    }
}

/**
 * Координация запуска Node в сервисном процессе. Статика между Android-процессами
 * не разделяется, поэтому все аргументы передаются явно через Intent.
 */
object ServerRunner {
    private const val DEFAULT_PORT = 4000
    private const val START_PENDING_MS = 15_000L

    @Volatile
    var url: String = ""
        private set

    @Volatile
    var port: Int = DEFAULT_PORT
        private set

    @Volatile
    private var startRequestedAt: Long = 0L

    @Synchronized
    fun start(context: Context, arguments: Array<String>, port: Int, dataDir: String) {
        this.port = port
        this.url = urlFor(port)
        this.startRequestedAt = System.currentTimeMillis()
        writeStarting(dataDir, port)
        try {
            VisionNodeService.start(context.applicationContext, arguments, port, dataDir)
        } catch (error: Throwable) {
            startRequestedAt = 0L
            url = ""
            writeFailure(dataDir, port, "Не удалось запустить Android Service: ${error.message ?: error}")
            throw error
        }
    }

    fun isStartPending(port: Int): Boolean =
        this.port == port && startRequestedAt > 0 && System.currentTimeMillis() - startRequestedAt < START_PENDING_MS

    fun isServerHealthy(port: Int): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("${urlFor(port)}/api/health").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 350
            connection.readTimeout = 350
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return false
            val payload = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            payload.optBoolean("ok") || payload.optString("status") == "ok"
        } catch (_: Throwable) {
            false
        } finally {
            connection?.disconnect()
        }
    }

    fun readPhase(dataDir: String): String? = try {
        val file = File(dataDir, "state.json")
        if (file.isFile) JSONObject(file.readText()).optString("phase").takeIf { it.isNotBlank() } else null
    } catch (_: Throwable) {
        null
    }

    fun stop(context: Context) {
        val target = url.ifBlank { urlFor(port) }
        startRequestedAt = 0L
        val appContext = context.applicationContext
        Thread({
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$target/api/shutdown").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 400
                connection.readTimeout = 600
                connection.responseCode
            } catch (error: Throwable) {
                Log.w("VisionNode", "Сервер не ответил на остановку: ${error.message}")
            } finally {
                connection?.disconnect()
                // Даём bootstrap записать `stopped` и завершить event loop. Если
                // Node завис, stopService всё равно освободит порт через 1,25 с.
                try {
                    Thread.sleep(1_250)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
                VisionNodeService.stop(appContext)
                url = ""
            }
        }, "vision-node-stop").start()
    }

    fun isPortBusy(port: Int): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress("127.0.0.1", port), 250)
                true
            }
        } catch (_: Throwable) {
            false
        }
    }

    fun dataDir(context: Context): String {
        val dir = File(context.filesDir, "vision-node")
        dir.mkdirs()
        return dir.absolutePath
    }

    /** Node не читает assets внутри APK; распаковываем скрипт в приватный filesDir. */
    fun ensureBootstrap(context: Context, dir: String): File {
        val target = File(dir, "bootstrap.mjs")
        val assets = context.assets
        val length = try {
            assets.openFd(BOOTSTRAP_ASSET).use { it.length }
        } catch (_: Throwable) {
            -1L
        }
        if (target.exists() && (length <= 0 || target.length() == length)) return target
        assets.open(BOOTSTRAP_ASSET).use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        }
        return target
    }

    fun urlFor(port: Int): String = "http://127.0.0.1:$port"

    fun writeFailure(dataDir: String, port: Int, reason: String) {
        writeState(dataDir, port, "failed", reason)
    }

    fun writeStarting(dataDir: String, port: Int) {
        writeState(dataDir, port, "starting", null)
    }

    fun markUnexpectedExit(dataDir: String, port: Int, code: Int) {
        val phase = readPhase(dataDir)
        if (phase == "stopped" || phase == "failed") return
        writeFailure(dataDir, port, "Node завершился неожиданно с кодом $code")
    }

    private fun writeState(dataDir: String, port: Int, phase: String, error: String?) {
        try {
            val directory = File(dataDir)
            directory.mkdirs()
            val json = JSONObject()
                .put("ok", phase == "running")
                .put("phase", phase)
                .put("port", port)
                .put("host", "127.0.0.1")
                .put("url", urlFor(port))
                .put("runtime", JSONObject.NULL)
                .put("mode", "embedded")
                .put("error", error ?: JSONObject.NULL)
                .put("at", System.currentTimeMillis())
            val file = File(directory, "state.json")
            val temp = File(directory, "state.json.tmp")
            temp.writeText(json.toString(), Charsets.UTF_8)
            if (!temp.renameTo(file)) {
                file.writeText(json.toString(), Charsets.UTF_8)
                temp.delete()
            }
        } catch (failure: Throwable) {
            Log.e("VisionNode", "Не удалось записать state.json: ${failure.message}", failure)
        }
    }

    private val BOOTSTRAP_ASSET = "nodejs-project/bootstrap.mjs"
}
