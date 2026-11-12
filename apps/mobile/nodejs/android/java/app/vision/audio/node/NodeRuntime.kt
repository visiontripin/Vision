package app.vision.audio.node

import androidx.annotation.Keep

/**
 * Тонкий владелец JNI-вызова Node. Он загружается только внутри
 * `VisionNodeService` (процесс `:vision_node`), а не в процессе плеера.
 *
 * Если libnode или сам Node аварийно завершится, Android остановит только
 * серверный процесс — библиотека, UI и плеер останутся живы.
 */
@Keep
object NodeRuntime {
    /** Загружать libnode в UI-процессе нельзя: native crash должен быть изолирован. */
    fun start(arguments: Array<String>, redirectLogcat: Boolean): Int {
        System.loadLibrary("visionnode")
        return nativeStart(arguments, redirectLogcat)
    }

    @Keep
    private external fun nativeStart(arguments: Array<String>, redirectLogcat: Boolean): Int
}
