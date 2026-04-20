plugins {
    application
    java
}


group = "tests"
version = "unspecified"

repositories {
    mavenCentral()
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    implementation(project(":lib"))
}

tasks.test {
    useJUnitPlatform()
}

application {
    mainClass.set("tests.Main")
}
