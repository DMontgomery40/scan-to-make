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
  @objc public var onPress: RCTDirectEventBlock?
  @objc public var onSizeChange: RCTDirectEventBlock? { didSet { reportedHeight = 0; setNeedsLayout() } }

  public override init(frame: CGRect) {
    super.init(frame: frame)
    addSubview(control)
    control.addTarget(self, action: #selector(activate), for: .primaryActionTriggered)
    isAccessibilityElement = false
    configure()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func configure() {
    var config: UIButton.Configuration
    if #available(iOS 26.0, *) {
      config = primary ? .prominentGlass() : .glass()
    } else {
      config = primary ? .filled() : .tinted()
    }
    let font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traitCollection)
    config.title = buttonTitle
    config.titleAlignment = .center
    config.titleLineBreakMode = .byWordWrapping
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var result = attributes
      result.font = font
      return result
    }
    config.contentInsets = NSDirectionalEdgeInsets(top: compact ? 8 : 14, leading: compact ? 12 : 20,
                                                   bottom: compact ? 8 : 14, trailing: compact ? 12 : 20)
    control.configuration = config
    control.isEnabled = !disabled
    control.titleLabel?.numberOfLines = 0
    control.accessibilityLabel = spokenLabel.isEmpty ? buttonTitle : spokenLabel
    control.accessibilityHint = hint
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
    guard bounds.width > 0 else { return }
    let horizontalPadding: CGFloat = compact ? 24 : 40
    let verticalPadding: CGFloat = compact ? 16 : 28
    let textSize = measureLabel.sizeThatFits(CGSize(width: max(1, bounds.width - horizontalPadding),
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
