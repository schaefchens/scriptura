Pod::Spec.new do |s|
  # Not Scriptura, which an app may well be called: its module would then hide this one.
  s.name           = 'ScripturaReactNative'
  s.version        = '0.0.0'
  s.summary        = "Scriptura's reader for React Native on iOS"
  s.description    = 'Scripture in pages or one endless scroll, laid out with TextKit 2 from the core in Rust'
  s.license        = 'Apache-2.0'
  s.author         = 'schaefchens'
  s.homepage       = 'https://github.com/schaefchens/scriptura'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/schaefchens/scriptura.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The core as a dynamic framework, which build.sh makes; generated/ holds its Swift bindings and
  # C header.
  s.vendored_frameworks = 'ScripturaCore.xcframework'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,swift}'
end
