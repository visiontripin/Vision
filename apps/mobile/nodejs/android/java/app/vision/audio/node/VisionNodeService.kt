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

/**
 * Держит Node-рантайм и HTTP-сервер живыми, пока приложение в памяти.
 *
 * Зачем foreground-сервис: Android останавливает обычные процессы в фоне через
 * несколько секунд. Без сервиса сервер исчезал бы, стоило заблокировать экран, и
 * пользователь видел бы «сервер работает» на экране, которого уже нет.
 *
 * Уведомление обязательно (так требует Android 8+) — простой текст, что сервер на
 * телефоне запущен.
 */
class VisionNodeService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, notification())
        ServerRunner.launchPending()
        // START_NOT_STICKY: если система убьёт сервис, сервер не должен подниматься
        // заново без ведома приложения — оно само покажет состояние.
        return START_NOT_STICKY
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
            .setContentText("Музыка и API доступны на этом телефоне")
            .setSmallIcon(android.R.drawable.stat_sys_headset)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "vision-node"
        /** Путь в assets APK: `bootstrap.mjs` копируется в каталог данных при старте. */
        const val BOOTSTRAP_ASSET = "nodejs-project/bootstrap.mjs"
        private const val NOTIFICATION_ID = 4711

        fun start(context: Context) {
            val intent = Intent(context, VisionNodeService::class.java)
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
 * Состояние запуска Node: один рантайм на приложение.
 *
 * Почему отдельный объект: `node::Start` — блокирующий вызов на весь срок жизни
 * сервера, поэтому он должен начаться уже внутри foreground-сервиса. Между
 * `startForegroundService` и `onStartCommand` есть задержка, и до неё аргументы
 * лежат в `pendingArguments`.
 */
object ServerRunner {
    @Volatile
    var running: Boolean = false
        private set

    @Volatile
    var url: String = ""
        private set

    @Volatile
    var port: Int = 4000
        private set

    @Volatile
    private var pendingArguments: Array<String>? = null

    @Volatile
    private var pendingStart: ((Array<String>) -> Int)? = null

    private var service: Context? = null

    fun start(context: Context, argv: Array<String>, port: Int, startNode: (Array<String>) -> Int) {
        this.port = port
        this.url = "http://127.0.0.1:$port"
        this.service = context.applicationContext
        pendingArguments = argv
        pendingStart = startNode
        running = true
        VisionNodeService.start(context)
    }

    /** Вызывается сервисом: Node занимает отдельный поток до конца сервера. */
    fun launchPending() {
        val argv = pendingArguments ?: return
        val start = pendingStart ?: return
        pendingArguments = null
        pendingStart = null
        Thread({
            try {
                Log.i("VisionNode", "Запуск Node: ${argv.joinToString(" ")}")
                val code = start(argv)
                Log.i("VisionNode", "Node завершился: $code")
            } catch (error: Throwable) {
                Log.e("VisionNode", "Node не запустился", error)
            } finally {
                running = false
            }
        }, "vision-node").start()
    }

    /**
     * Остановка через сам сервер: `POST /api/shutdown` закрывает сокет и даёт
     * событийному циклу Node завершиться. Убивать поток нельзя — Node не успеет
     * записать `state.json`, и приложение будет считать сервер живым.
     */
    fun stop(context: Context) {
        val target = url
        running = false
        if (target.isNotEmpty()) {
            Thread({
                try {
                    val connection = URL("$target/api/shutdown").openConnection() as HttpURLConnection
                    connection.requestMethod = "POST"
                    connection.connectTimeout = 400
                    connection.readTimeout = 400
                    connection.responseCode
                    connection.disconnect()
                } catch (error: Throwable) {
                    Log.w("VisionNode", "Сервер не ответил на остановку: ${error.message}")
                }
            }, "vision-node-stop").start()
        }
        pendingArguments = null
        pendingStart = null
        VisionNodeService.stop(context)
    }

    /** Быстрая проверка «порт занят» без запуска Node. */
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

    /** Путь к каталогу данных: `filesDir/vision-node` (переживает обновление APK). */
    fun dataDir(context: Context): String {
        val dir = File(context.filesDir, "vision-node")
        dir.mkdirs()
        return dir.absolutePath
    }

    /**
     * Распаковывает `bootstrap.mjs` из assets в каталог данных.
     *
     * Node не умеет читать assets внутри APK — это не файловая система. Поэтому при
     * каждом старте копируем скрипт, если он отличается по размеру (обновление
     * приложения приносит новую версию скрипта, а `state.json` и библиотека
     * остаются на месте).
     */
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
}
