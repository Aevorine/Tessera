import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 发布签名：密钥库和口令在仓库外，由 TESSERA_ANDROID_KEYSTORE_PROPS 指向；变量未设才退回未签名
// 构建。
// 不给仓库内默认路径：否则迟早有人把 .jks 提交进去，签名密钥泄露后任何人都能签出冒充的更新包。
// 须写在 android {} 外并用文件顶部的 import：脚本里的 `java` 是 Gradle 扩展而非 java.* 包。
// 变量设了但文件不在必须立即失败，不能静默退回未签名（曾因路径写错 BUILD SUCCESSFUL 却产出装不
// 上的 unsigned APK）；
// 未设是有意的未签名构建（贡献者、CI 编译检查），设了却指不到是配置错误。
val keystorePropsPath: String? = System.getenv("TESSERA_ANDROID_KEYSTORE_PROPS")
if (!keystorePropsPath.isNullOrBlank() && !File(keystorePropsPath).isFile) {
    throw GradleException(
        "TESSERA_ANDROID_KEYSTORE_PROPS 指向的文件不存在：$keystorePropsPath\n" +
        "继续构建只会产出装不上的未签名 APK。要做未签名构建请把这个变量整个取消设置。"
    )
}

val keystoreProps: Properties? =
    keystorePropsPath
        ?.let { File(it) }
        ?.takeIf { it.isFile }
        ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

// 密钥库文件本身也要在同一刻检查：properties 在、.jks 被挪走了，
// 报出来的会是一句 keytool 层面的 IOException，跟"密钥配置错了"看不出关系。
if (keystoreProps != null) {
    val store = File(keystoreProps.getProperty("storeFile") ?: "")
    if (!store.isFile) {
        throw GradleException("密钥库文件不存在：${store.path}（来自 $keystorePropsPath 的 storeFile）")
    }
}

android {
    namespace = "com.tessera.crossdevice"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tessera.crossdevice"
        minSdk = 26          // 跟 gomobile bind 的 -androidapi 26 对齐
        targetSdk = 35
        // versionCode 每次发版必须递增（与 versionName 一起改）：忘了递增时安装包正常却被系统拒装。
        versionCode = 49
        versionName = "0.1.48"
        // .aar 里只有 arm64 和 x86_64（真机基本都是 arm64，x86_64 给模拟器）。
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        if (keystoreProps != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8 混淆 + 资源裁剪。tesseracore.aar 自带 consumer proguard 规则（keep go.** / mobile.**），
            // 应用代码无反射，native 方法类的 keep 见 proguard-rules.pro。
            // 出问题改回 false；先用 mapping.txt 还原堆栈，UnsatisfiedLinkError 基本是 keep 规则漏了。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                // Android 官方基线规则。用 -optimize 那份：它比默认那份多开一组
                // 优化，而本项目没有依赖 "不被内联" 这类隐含假设的代码。
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (keystoreProps != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn("未设 TESSERA_ANDROID_KEYSTORE_PROPS，产出的是未签名 APK，装不上设备。")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
    // 字体不压缩：系统直接 mmap，首帧不用先解压 3 MB。
    androidResources { noCompress += "ttf" }
}

dependencies {
    // 协议核心：跟 Windows 守护进程同一份 Go 代码，由 gomobile bind 产出。
    implementation(files("libs/tesseracore.aar"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    // 分区展开/折叠的高度动画。用 androidx 版而不是平台自带的 android.transition：
    // 后者在部分厂商 ROM 上对 NestedScrollView 里的 GONE 切换会闪一下。
    implementation("androidx.transition:transition:1.5.1")

    // 扫码：CameraX + ML Kit。用 bundled 版：Play 服务版首次要联网下模型，而配对常发生在刚装好未配网时
    // 。
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // 生成配对二维码。只用它的编码器，不用它的扫描器（扫描交给 ML Kit，识别率更高）。
    implementation("com.google.zxing:core:3.5.3")
    // 应用锁：走系统的 BiometricPrompt，应用拿不到也存不了指纹/面容模板。
    implementation("androidx.biometric:biometric:1.1.0")

    testImplementation("junit:junit:4.13.2")
    // org.json 真实实现：单测 classpath 上的 SDK 版是 "Stub!" 抛异常。
    // 不用 returnDefaultValues=true，它会让未实现的 API 静默返回 null/0，测试绿但测的是空。
    testImplementation("org.json:json:20240303")
}
