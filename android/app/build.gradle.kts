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

// Release credentials stay in user Gradle properties or the build process environment.
fun releaseSetting(name: String) = providers.gradleProperty(name)
    .orElse(providers.environmentVariable(name)).orNull
val releaseStore = releaseSetting("COUNTERPART_ANDROID_KEYSTORE")
val releaseStorePassword = releaseSetting("COUNTERPART_ANDROID_STORE_PASSWORD")
val releaseKeyAlias = releaseSetting("COUNTERPART_ANDROID_KEY_ALIAS")
val releaseKeyPassword = releaseSetting("COUNTERPART_ANDROID_KEY_PASSWORD")
val releaseCredentials = listOf(releaseStore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
require(releaseCredentials.all { it == null } || releaseCredentials.all { !it.isNullOrBlank() }) {
    "Provide all four COUNTERPART_ANDROID signing settings, or none for an unsigned build."
}

android {
    signingConfigs {
        if (releaseStore != null) {
            create("counterpartRelease") {
                storeFile = file(releaseStore)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    namespace = "com.scantomake.counterpart"
    sourceSets["main"].assets.srcDir(starterAssets.map { it.destinationDir })
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        // Same identifier as the iPhone app's bundle id.
        applicationId = "com.scantomake"
        minSdk = 26
        targetSdk = 35
        versionCode = releaseSetting("COUNTERPART_ANDROID_VERSION_CODE")?.toInt() ?: 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("counterpartRelease")
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
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.isIncludeAndroidResources = true
    }
    lint {
        // The shared test fixtures live outside this folder (packages/contracts/fixtures).
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = false
    }
    packaging { resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF") }
}

tasks.named("preBuild") { dependsOn(starterAssets) }

// One trunk: anything that can be installed or shipped (assemble/bundle/install, any variant) is built
// only from a clean commit on origin/main. Local debugging: STM_TRUNK_OVERRIDE="<why>" (logged).
val trunkGuard = tasks.register<Exec>("trunkGuard") {
    commandLine("bash", rootProject.file("scripts/trunk-guard.sh").absolutePath, "the Android app")
}
tasks.matching { Regex("^(assemble|bundle|install)(Debug|Release)?$").matches(it.name) }.configureEach { dependsOn(trunkGuard) }

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
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}
