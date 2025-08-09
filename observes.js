// observers.js
class CacheCleanupObserver {
  update() {
    cleanupCache(cacheDir, 60);
  }
}

class StatsResetObserver {
  update() {
    resetDailyStats();
  }
}

class Subject {
  constructor() {
    this.observers = [];
  }

  addObserver(observer) {
    this.observers.push(observer);
  }

  notifyObservers() {
    this.observers.forEach(observer => observer.update());
  }
}

export { Subject, CacheCleanupObserver, StatsResetObserver };