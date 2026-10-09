plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystoreFile: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "app.spectacle"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.spectacle.family"
        minSdk = 26          // Android 8.0+, so older phones can be cameras
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = "spectacle"
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystoreFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }
    lint { abortOnError = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
