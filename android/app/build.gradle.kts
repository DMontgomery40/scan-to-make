plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Use the same curated catalog and pictures as the Apple clients. Geometry stays on the companion.
val starterAssets = tasks.register<Sync>("prepareStarterAssets") {
    from("../../packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters") {
        include("catalog.json", "**/*.png")
        into("Starters")
    }
    into(layout.buildDirectory.dir("generated/starter-assets"))
}

android {
    namespace = "com.scantomake.counterpart"
    sourceSets["main"].assets.srcDir(starterAssets.map { it.destinationDir })
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        // Same identifier as the iPhone app's bundle id.
        applicationId = "com.scantomake"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    testOptions { unitTests.isReturnDefaultValues = true }
    lint {
        // The shared test fixtures live outside this folder (packages/contracts/fixtures).
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = false
    }
    packaging { resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF") }
}

tasks.named("preBuild") { dependsOn(starterAssets) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)
    implementation(libs.arcore)
    implementation(libs.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}
