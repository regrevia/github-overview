plugins { id("com.android.application") }

android {
  namespace = "com.regrevia.githuboverview"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.regrevia.githuboverview"
    minSdk = 24
    targetSdk = 35
    versionCode = 24
    versionName = "0.2.4"
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
