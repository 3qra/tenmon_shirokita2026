# kotlinx.serialization（@Serializable クラスのシリアライザを保持）
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class jp.gakusai.portal.**$$serializer { *; }
-keepclassmembers class jp.gakusai.portal.** { *** Companion; }
-keepclasseswithmembers class jp.gakusai.portal.** { kotlinx.serialization.KSerializer serializer(...); }

# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Tink（security-crypto）
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
