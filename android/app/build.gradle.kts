plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/** Gradleプロパティ → 環境変数 → 既定値 の順で値を決める。 */
fun prop(name: String, default: String? = null): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }
        ?: default

/** BuildConfig 用の文字列リテラル。 */
fun quoted(v: String) = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val releaseStoreFile = prop("RELEASE_STORE_FILE")

android {
    namespace = "jp.gakusai.portal"
    compileSdk = 35

    defaultConfig {
        applicationId = "jp.gakusai.portal"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        manifestPlaceholders["appLinkHost"] = prop("APP_LINK_HOST", "example.com")!!
    }

    signingConfigs {
        // 署名鍵・パスワードはリポジトリに含めない。指定がなければ未署名のリリースAPK/AABになる。
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = prop("RELEASE_STORE_PASSWORD")
                keyAlias = prop("RELEASE_KEY_ALIAS")
                keyPassword = prop("RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "API_BASE_URL", quoted(prop("API_BASE_URL_DEBUG", "http://10.0.2.2:8080")!!))
            buildConfigField("String", "WEB_BASE_URL", quoted(prop("WEB_BASE_URL_DEBUG", "http://10.0.2.2:3000")!!))
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "API_BASE_URL", quoted(prop("API_BASE_URL", "https://example.com")!!))
            buildConfigField("String", "WEB_BASE_URL", quoted(prop("WEB_BASE_URL", "https://example.com")!!))
            if (releaseStoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)

    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.zxing.core)

    implementation(libs.androidx.security.crypto)

    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
}
