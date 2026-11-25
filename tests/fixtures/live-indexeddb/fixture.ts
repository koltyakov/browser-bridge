/** Seed a new database in the selected page and clean up only after Chrome
 * confirms that this call created it. An uncertain setup must not delete. */
export async function withLiveIndexedDbFixture(
  evaluate: (expression: string) => Promise<unknown>,
  marker: string,
  check: (database: string) => Promise<void>
): Promise<void> {
  const database = `bbx-live-${crypto.randomUUID()}`;
  const name = JSON.stringify(database);
  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open(${name});
    let created = false;
    request.onupgradeneeded = () => {
      created = true;
      request.result.createObjectStore('items', {keyPath: 'id'}).add({id: 1, marker: ${JSON.stringify(marker)}});
    };
    request.onsuccess = () => {
      request.result.close();
      if (created) resolve(true);
      else reject(new Error('Fixture database already exists.'));
    };
    request.onerror = () => reject(request.error);
  })`);
  try {
    await check(database);
  } finally {
    await evaluate(`new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(${name});
      request.onsuccess = () => {
        indexedDB.databases().then((databases) => {
          if (databases.some((database) => database.name === ${name}))
            reject(new Error('Fixture database still exists after cleanup.'));
          else resolve(true);
        }, reject);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Fixture database cleanup blocked.'));
    })`);
  }
}
