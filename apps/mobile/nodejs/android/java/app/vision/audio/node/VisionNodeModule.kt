package app.vision.audio.node

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File

/**
 * `NativeModules.VisionNode` — управление встроенным Node-рантаймом из JS.
 *
 * Контракт маленький и «без сюрпризов»:
 *
 *  - `startServer` **не ждёт** запуска Node (он живёт до конца работы сервера), а
 *    возвращает адрес, который должен начать отвечать: `http://127.0.0.1:<port>`.
 *    Если порт занят — возвращает строку `EADDRINUSE: …`, а не reject: JS-слой по
 *    этой строке решает, пробовать соседний порт или сдаваться.
 *  - `readState` читает `state.json`, который пишет `bootstrap.mjs` — единственный
 *    честный источник «сервер действительно поднялся».
 */
class VisionNodeModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    override fun getName(): String = "VisionNode"

    /** Ленивая загрузка: если `.so` нет в сборке, приложение не должно падать. */
    private val loaded: Boolean by lazy {
        try {
            System.loadLibrary("visionnode")
            true
        } catch (error: Throwable) {
            false
        }
    }

    private external fun nativeStart(arguments: Array<String>, redirectLogcat: Boolean): Int
    private external fun nativeAbi(): String

    @ReactMethod
    fun startServer(options: ReadableMap, promise: Promise) {
        if (!loaded) {
            promise.resolve("runtime_unavailable: libvisionnode.so отсутствует в сборке")
            return
        }
        if (ServerRunner.running) {
            promise.resolve(ServerRunner.url)
            return
        }

        val port = if (options.hasKey("port")) options.getInt("port") else 4000
        val public = options.hasKey("public") && options.getBoolean("public")
        val token = if (options.hasKey("token") && !options.isNull("token")) options.getString("token") else null
        val dataDir = if (options.hasKey("dataDir") && !options.isNull("dataDir")) {
            options.getString("dataDir")!!
        } else {
            ServerRunner.dataDir(context)
        }

        // Порт занят? Проверяем до запуска Node: ошибка приходит сразу, а не через
        // несколько секунд томительного ожидания.
        if (ServerRunner.isPortBusy(port)) {
            promise.resolve("EADDRINUSE: порт $port уже занят")
            return
        }

        // Node не может читать assets из APK напрямую — копируем скрипт в filesDir.
        val script = try {
            ServerRunner.ensureBootstrap(context, dataDir)
        } catch (error: Throwable) {
            promise.resolve("missing_bootstrap: ${error.message}")
            return
        }

        val argv = mutableListOf(
            "node",
            "--no-warnings",
            script.absolutePath,
            "--data", dataDir,
            "--port", port.toString(),
        )
        if (public) argv.add("--public")
        if (!token.isNullOrEmpty()) {
            argv.add("--auth")
            argv.add(token)
        }

        ServerRunner.start(context, argv.toTypedArray(), port) { nativeStart(it, true) }
        promise.resolve(ServerRunner.url)
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        ServerRunner.stop(context)
        promise.resolve(true)
    }

    /** Содержимое `state.json` или `null`, если файла ещё нет. */
    @ReactMethod
    fun readState(promise: Promise) {
        try {
            val stateFile = File(ServerRunner.dataDir(context), "state.json")
            val map = Arguments.createMap()
            map.putString("state", if (stateFile.exists()) stateFile.readText() else null)
            promise.resolve(map)
        } catch (error: Throwable) {
            promise.reject("state_unreadable", error.message, error)
        }
    }

    @ReactMethod
    fun runtimeVersion(promise: Promise) {
        // Версия Node приходит из `state.json`, а не из JVM: рантайм живёт в своём
        // процессе-потоке, и Java про его версию ничего не знает.
        promise.resolve(null as String?)
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(loaded)
    }

    @ReactMethod
    fun abi(promise: Promise) {
        promise.resolve(if (loaded) nativeAbi() else "unknown")
    }
}
