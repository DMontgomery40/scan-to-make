require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ScanCapture"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/DMontgomery40/scan-to-make"
  s.license      = { :type => "UNLICENSED" }
  s.authors      = "Scan to Make"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/DMontgomery40/scan-to-make.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.frameworks   = "ARKit", "SceneKit", "UIKit"
  s.swift_version = "5.9"

  install_modules_dependencies(s)
end
