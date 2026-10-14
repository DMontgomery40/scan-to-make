Pod::Spec.new do |s|
  s.name = "LocalProjectStorage"
  s.version = "0.0.1"
  s.summary = "Transactional local saved-project storage"
  s.homepage = "https://github.com/DMontgomery40/scan-to-make"
  s.license = { :type => "UNLICENSED" }
  s.authors = "Scan to Make"
  s.source = { :git => s.homepage + ".git", :tag => s.version }
  s.platforms = { :ios => min_ios_version_supported }
  s.source_files = "ios/*.{h,m,mm}"
  s.libraries = "sqlite3"
  s.frameworks = "SceneKit", "UIKit"
  install_modules_dependencies(s)
end
