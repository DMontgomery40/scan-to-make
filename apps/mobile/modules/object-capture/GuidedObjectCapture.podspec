Pod::Spec.new do |s|
  s.name = 'GuidedObjectCapture'
  s.version = '0.0.1'
  s.summary = 'Guided local object capture for saved projects'
  s.homepage = 'https://github.com/DMontgomery40/scan-to-make'
  s.license = { :type => 'Apple Sample Code', :file => 'LICENSE.txt' }
  s.authors = 'Scan to Make'
  s.source = { :git => s.homepage + '.git', :tag => s.version }
  s.platforms = { :ios => '18.0' }
  s.swift_version = '5.0'
  sample = 'GuidedCaptureSample/GuidedCaptureSample'
  s.source_files = 'ios/*.{swift,mm}', "#{sample}/**/*.swift"
  s.exclude_files = "#{sample}/GuidedCaptureSampleApp.swift"
  # The reused sample explicitly resolves guidance resources from Bundle.main.
  s.resources = ["#{sample}/Resources/*", "GuidedCaptureSample/en.lproj/Localizable.strings"]
  s.preserve_paths = "#{sample}/Assets.xcassets", "#{sample}/PrivacyInfo.xcprivacy"
  s.frameworks = 'RealityKit', 'ARKit', 'SwiftUI', 'AVKit', 'CryptoKit', 'UIKit'
  install_modules_dependencies(s)
end
