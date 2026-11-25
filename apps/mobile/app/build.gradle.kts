plugins { id("com.android.application") }

android {
  namespace = "com.regrevia.githuboverview"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.regrevia.githuboverview"
    minSdk = 24
    targetSdk = 35
    versionCode = 36
    versionName = "0.3.1"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}
