# Lumen — Homebrew formula (placeholder)
# Install: brew install awabuda/tap/lumen
class Lumen < Formula
  desc "Self-improving TypeScript agent framework"
  homepage "https://github.com/awabuda/lumen"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/awabuda/lumen/releases/download/v0.1.0/lumen-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  def install
    bin.install "lumen"
  end

  test do
    system "#{bin}/lumen", "doctor"
  end
end
