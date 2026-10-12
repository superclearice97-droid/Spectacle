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
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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

    // Assets are copied at build time, keeping one canonical set of offline models in the repo.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/offlineAssets"))
    sourceSets.getByName("androidTest").assets.srcDir(rootProject.file("../test-images"))
    buildFeatures { buildConfig = true }
    lint { abortOnError = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("androidx.camera:camera-video:1.4.2")
    implementation("org.tensorflow:tensorflow-lite:2.17.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

val offlineAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../models")) { into("models") }
    into(layout.buildDirectory.dir("generated/offlineAssets"))
}
tasks.named("preBuild") { dependsOn(offlineAssets) }
