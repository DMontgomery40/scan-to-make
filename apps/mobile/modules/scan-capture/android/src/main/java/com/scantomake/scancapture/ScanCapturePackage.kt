package com.scantomake.scancapture

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class ScanCapturePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == ScanCaptureModule.NAME) ScanCaptureModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      ScanCaptureModule.NAME to
        ReactModuleInfo(
          ScanCaptureModule.NAME,
          ScanCaptureModule::class.java.name,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // isCxxModule
          true, // isTurboModule
        ),
    )
  }
}
