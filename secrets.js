// Loaded only by trusted extension pages and the service worker, never content scripts.
// Local storage persists on this device; it is not an encrypted credential vault.
const WriteWiseSecrets = (() => {
  const keys = ['openaiKey', 'deepseekKey'];
  const retiredKeys = ['claudeKey', 'geminiKey', 'groqKey'];
  const ready = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Removed providers are no longer used or retained.
    await chrome.storage.local.remove(retiredKeys);
    await chrome.storage.sync.remove(retiredKeys);
    const [legacy, local] = await Promise.all([
      chrome.storage.sync.get(keys), chrome.storage.local.get(keys)
    ]);
    const migrated = {};
    for (const key of keys) {
      if (legacy[key] && local[key] === undefined) migrated[key] = legacy[key];
    }
    if (Object.keys(migrated).length) await chrome.storage.local.set(migrated);
    // Remove synced copies only after the local write succeeds.
    await chrome.storage.sync.remove(keys);
  })();
  // Keep failures observable by callers without an unhandled startup rejection.
  ready.catch(() => {});
  return {
    ready,
    async get() { await ready; return chrome.storage.local.get(keys); },
    async set(key, value) {
      await ready;
      if (!keys.includes(key)) throw new Error('Unknown credential');
      if (value) await chrome.storage.local.set({ [key]: value });
      else await chrome.storage.local.remove(key);
      await chrome.storage.sync.remove(key);
    }
  };
})();
