/*
 * Мост Java → Node: единственный C++-файл, который нужен приложению.
 *
 * Почему не форк `nodejs-mobile-react-native` целиком: нам не нужен его протокол
 * сообщений (`rn-bridge`) — сервер общается по HTTP. Нужны только две вещи:
 *
 *   1. `node::Start(argc, argv)` в отдельном потоке — это и есть «поднять сервер»;
 *   2. перенаправление stdout/stderr в logcat, иначе падение Node на телефоне
 *      выглядит как «приложение молчит».
 *
 * Компилируется против заголовков Node (`include/node/node.h`) и линкуется с
 * prebuilt `libnode.so` под конкретный ABI — см. CMakeLists.txt рядом.
 */
#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "VisionNode"

// --- stdout/stderr в logcat -------------------------------------------------
static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;

static void* stdout_reader(void*) {
  ssize_t size;
  char buf[2048];
  while ((size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
    if (buf[size - 1] == '\n') --size;
    buf[size] = 0;
    __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
  }
  return nullptr;
}

static void* stderr_reader(void*) {
  ssize_t size;
  char buf[2048];
  while ((size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
    if (buf[size - 1] == '\n') --size;
    buf[size] = 0;
    __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, buf);
  }
  return nullptr;
}

static int redirect_output() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  if (pipe(pipe_stdout) != 0) return -1;
  dup2(pipe_stdout[1], STDOUT_FILENO);

  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(pipe_stderr) != 0) return -1;
  dup2(pipe_stderr[1], STDERR_FILENO);

  if (pthread_create(&thread_stdout, nullptr, stdout_reader, nullptr) != 0) return -1;
  pthread_detach(thread_stdout);
  if (pthread_create(&thread_stderr, nullptr, stderr_reader, nullptr) != 0) return -1;
  pthread_detach(thread_stderr);
  return 0;
}

// --- JNI --------------------------------------------------------------------
extern "C" {

/** ABI текущей сборки — приложению нужно знать, что именно запущено. */
JNIEXPORT jstring JNICALL
Java_app_vision_audio_node_VisionNodeModule_nativeAbi(JNIEnv* env, jobject) {
#if defined(__aarch64__)
  return env->NewStringUTF("arm64-v8a");
#elif defined(__arm__)
  return env->NewStringUTF("armeabi-v7a");
#elif defined(__x86_64__)
  return env->NewStringUTF("x86_64");
#else
  return env->NewStringUTF("unknown");
#endif
}

/**
 * Блокирующий запуск Node. Вызывается из Java-потока: когда Node завершится
 * (упадёт или его остановят), вернётся код выхода.
 *
 * `argv` собирается на стороне Java; здесь только выравниваем его в непрерывный
 * буфер, как требует libuv (`uv_setup_args` ожидает один блок памяти).
 */
JNIEXPORT jint JNICALL
Java_app_vision_audio_node_VisionNodeModule_nativeStart(
    JNIEnv* env, jobject, jobjectArray arguments, jboolean redirect_logcat) {
  const jsize count = env->GetArrayLength(arguments);

  size_t size = 0;
  for (jsize i = 0; i < count; i += 1) {
    jstring item = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* text = env->GetStringUTFChars(item, nullptr);
    size += std::strlen(text) + 1;
    env->ReleaseStringUTFChars(item, text);
    env->DeleteLocalRef(item);
  }

  char* buffer = (char*)calloc(size, sizeof(char));
  if (buffer == nullptr) return -1;

  char* argv[count > 0 ? count : 1];
  char* cursor = buffer;
  for (jsize i = 0; i < count; i += 1) {
    jstring item = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* text = env->GetStringUTFChars(item, nullptr);
    std::strcpy(cursor, text);
    argv[i] = cursor;
    cursor += std::strlen(text) + 1;
    env->ReleaseStringUTFChars(item, text);
    env->DeleteLocalRef(item);
  }

  if (redirect_logcat && redirect_output() != 0) {
    __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, "Не удалось перенаправить stdout/stderr в logcat");
  }

  // Ключевая часть: Node получает управление и занимает поток до остановки.
  const int code = node::Start(count, argv);
  __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "Node завершился с кодом %d", code);

  free(buffer);
  return code;
}

}  // extern "C"
