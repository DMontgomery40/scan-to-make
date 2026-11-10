pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's mirror of Maven Central, ahead of Central: Central answers Robolectric's 158 MB native runtime
        // jar with 429 Too Many Requests to busy addresses (agents-171, Nov 2026), even when it is already cached.
        maven("https://maven-central.storage-download.googleapis.com/maven2/") {
            name = "MavenCentralGoogleMirror"
        }
        mavenCentral()
    }
}
rootProject.name = "Counterpart"
include(":app")
