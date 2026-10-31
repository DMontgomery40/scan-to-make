import UIKit
import React

/// The native control owns its material, interaction and accessibility behavior.
@objc(STMActionButton)
public final class STMActionButton: UIView {
  private let control = UIButton(type: .system)
  private let measureLabel = UILabel()
  private var reportedHeight: CGFloat = 0

  @objc public var buttonTitle: String = "" { didSet { configure() } }
  @objc public var spokenLabel: String = "" { didSet { configure() } }
  @objc public var hint: String? { didSet { configure() } }
  @objc public var primary: Bool = false { didSet { configure() } }
  @objc public var compact: Bool = false { didSet { configure() } }
  @objc public var disabled: Bool = false { didSet { configure() } }
  /// An SF Symbol shown before the title, or alone when the title is empty.
  @objc public var systemImage: String? { didSet { configure() } }
  @objc public var onPress: RCTDirectEventBlock?
  @objc public var onSizeChange: RCTDirectEventBlock? { didSet { reportedHeight = 0; setNeedsLayout() } }

  public override init(frame: CGRect) {
    super.init(frame: frame)
    addSubview(control)
    control.addTarget(self, action: #selector(activate), for: .primaryActionTriggered)
    // Only the UIButton is an accessibility element. React Native also applies
    // accessibility props to this wrapper, which made VoiceOver and XCUITest
    // find the same button more than once (KAN-187).
    isAccessibilityElement = false
    accessibilityElements = [control]
    configure()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// The clay fill for primary actions (theme.ts `clay`). White text on it is 4.6:1.
  private static let accent = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0xF0 / 255, green: 0x8A / 255, blue: 0x63 / 255, alpha: 1)
      : UIColor(red: 0xC4 / 255, green: 0x51 / 255, blue: 0x2B / 255, alpha: 1)
  }

  private var iconOnly: Bool { buttonTitle.isEmpty && systemImage != nil }

  private func configure() {
    var config: UIButton.Configuration = primary ? .prominentGlass() : .glass()
    let font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traitCollection)
    config.title = buttonTitle.isEmpty ? nil : buttonTitle
    if let systemImage, let image = UIImage(systemName: systemImage) {
      config.image = image
      config.imagePadding = 8
      config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .headline)
    } else {
      config.image = nil
    }
    if iconOnly { config.cornerStyle = .capsule }
    config.titleAlignment = .center
    config.titleLineBreakMode = .byWordWrapping
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = font
      return result
    }
    config.contentInsets = iconOnly
      ? NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
      : NSDirectionalEdgeInsets(top: compact ? 8 : 14, leading: compact ? 12 : 20,
                                bottom: compact ? 8 : 14, trailing: compact ? 12 : 20)
    control.configuration = config
    // Primary actions use the app's clay accent (theme.ts `accent`), not system blue.
    control.tintColor = primary ? Self.accent : nil
    control.isEnabled = !disabled
    control.titleLabel?.numberOfLines = 0
    control.accessibilityLabel = spokenLabel.isEmpty ? buttonTitle : spokenLabel
    control.accessibilityHint = hint
    accessibilityLabel = nil
    accessibilityHint = nil
    accessibilityTraits = []
    measureLabel.font = font
    measureLabel.text = buttonTitle
    measureLabel.numberOfLines = 0
    measureLabel.lineBreakMode = .byWordWrapping
    setNeedsLayout()
  }

  public override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      configure()
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    control.frame = bounds
    guard bounds.width > 0, !iconOnly else { return }
    let horizontalPadding: CGFloat = compact ? 24 : 40
    let verticalPadding: CGFloat = compact ? 16 : 28
    // The SF Symbol and its padding sit beside the title, so the title wraps sooner.
    var imageAllowance: CGFloat = 0
    if let systemImage, let image = UIImage(systemName: systemImage,
                                            withConfiguration: UIImage.SymbolConfiguration(textStyle: .headline)) {
      imageAllowance = image.size.width + 8
    }
    let textSize = measureLabel.sizeThatFits(CGSize(width: max(1, bounds.width - horizontalPadding - imageAllowance),
                                                   height: CGFloat.greatestFiniteMagnitude))
    let height = max(compact ? 48 : 56, ceil(textSize.height + verticalPadding))
    if height != reportedHeight, let onSizeChange {
      reportedHeight = height
      // Report after layout; React Native owns the wrapper's size.
      DispatchQueue.main.async { [weak self] in
        guard let self, self.reportedHeight == height else { return }
        onSizeChange(["height": height])
      }
    }
  }

  @objc private func activate() {
    guard !disabled else { return }
    onPress?([:])
  }
}
