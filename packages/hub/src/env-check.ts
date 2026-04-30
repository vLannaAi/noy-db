function checkEnvironment(): void {
  // Node.js version check
  if (typeof process !== 'undefined' && process.versions?.node) {
    const major = parseInt(process.versions.node.split('.')[0]!, 10)
    if (major < 18) {
      throw new Error(
        `@noy-db/core requires Node.js 18 or later (found ${process.versions.node}). ` +
        'Node.js 18+ is required for the Web Crypto API (crypto.subtle).',
      )
    }
  }

  // Web Crypto API availability (works in both Node and browser)
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    throw new Error(
      '@noy-db/core requires the Web Crypto API (crypto.subtle). ' +
      'Ensure you are running Node.js 18+ or a modern browser ' +
      '(Chrome 63+, Firefox 57+, Safari 13+).',
    )
  }
}

checkEnvironment()
