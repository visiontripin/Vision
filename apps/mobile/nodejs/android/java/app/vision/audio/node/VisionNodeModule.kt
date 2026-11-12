package app.vision.audio.node

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.util.zip.ZipFile

/**
 * `NativeModules.VisionNode` — управление встроенным Node-рантаймом из JS.
 *
 * Важно: этот модуль живёт в процессе приложения, но сам Node запускается
 * отдельным foreground-сервисом в `:vision_node`. Здесь никогда не вызывается
 * `System.loadLibrary`: даже ошибка загрузки `libnode.so` не должна закрыть
 * плеер.
 */
class VisionNodeModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    override fun getName(): String = "VisionNode"

    @ReactMethod
    fun startServer(options: ReadableMap, promise: Promise) {
        try {
            if (!hasEmbeddedRuntime(context)) {
                promise.resolve("runtime_unavailable: libvisionnode.so/libnode.so отсутствуют в сборке")
                return
            }

            val port = if (options.hasKey("port") && !options.isNull("port")) options.getInt("port") else DEFAULT_PORT
            if (port !in 1..65535) {
                promise.resolve("invalid_port: порт должен быть от 1 до 65535")
                return
            }
            val public = options.hasKey("public") && options.getBoolean("public")
            val token = if (options.hasKey("token") && !options.isNull("token")) options.getString("token") else null
            val dataDir = if (options.hasKey("dataDir") && !options.isNull("dataDir")) {
                options.getString("dataDir")!!
            } else {
                ServerRunner.dataDir(context)
            }

            // Повторный вызов при старте приложения не должен поднимать второй Node.
            if (ServerRunner.isServerHealthy(port)) {
                promise.resolve(ServerRunner.urlFor(port))
                return
            }
            if (ServerRunner.isStartPending(port) && ServerRunner.readPhase(dataDir) != "failed") {
                promise.resolve(ServerRunner.urlFor(port))
                return
            }
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

            ServerRunner.start(context.applicationContext, argv.toTypedArray(), port, dataDir)
            // Адрес возвращается сразу; JS отдельно ждёт HTTP health-check, а не
            // считает факт старта Android Service признаком готового сервера.
            promise.resolve(ServerRunner.urlFor(port))
        } catch (error: Throwable) {
            // Ошибка Android Service/Intent должна стать текстом диагностики, а
            // не необработанным исключением на мосту React Native.
            promise.resolve("service_start_failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        try {
            ServerRunner.stop(context)
            promise.resolve(true)
        } catch (_: Throwable) {
            promise.resolve(false)
        }
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
        // процессе, и Java про его версию ничего не знает.
        promise.resolve(null as String?)
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(hasEmbeddedRuntime(context))
    }

    /** Архив APK и распакованные библиотеки проверяются без их загрузки в UI-процесс. */
    private fun hasEmbeddedRuntime(context: ReactApplicationContext): Boolean {
        val libraryDir = File(context.applicationInfo.nativeLibraryDir ?: "")
        if (File(libraryDir, "libvisionnode.so").isFile && File(libraryDir, "libnode.so").isFile) return true

        return try {
            ZipFile(context.applicationInfo.sourceDir).use { apk ->
                Build.SUPPORTED_ABIS.any { abi ->
                    apk.getEntry("lib/$abi/libvisionnode.so") != null &&
                        apk.getEntry("lib/$abi/libnode.so") != null
                }
            }
        } catch (_: Throwable) {
            false
        }
    }

    private companion object {
        const val DEFAULT_PORT = 4000
    }
}
