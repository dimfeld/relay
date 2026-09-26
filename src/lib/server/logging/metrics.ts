export interface MetricsSnapshot {
  incomingEvents: number;
  classifier: {
    runs: number;
    failures: number;
    latencyMs: { count: number; total: number; max: number };
  };
  deliveryRetries: number;
}

export interface OperationalMetrics {
  recordIncomingEvent(): void;
  recordClassification(durationMs: number, failed: boolean): void;
  recordDeliveryRetry(): number;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

export function createOperationalMetrics(): OperationalMetrics {
  let incomingEvents = 0;
  let classifierRuns = 0;
  let classifierFailures = 0;
  let classifierLatencyCount = 0;
  let classifierLatencyTotal = 0;
  let classifierLatencyMax = 0;
  let deliveryRetries = 0;

  return {
    recordIncomingEvent() {
      incomingEvents += 1;
    },
    recordClassification(durationMs, failed) {
      classifierRuns += 1;
      if (failed) classifierFailures += 1;
      classifierLatencyCount += 1;
      classifierLatencyTotal += durationMs;
      classifierLatencyMax = Math.max(classifierLatencyMax, durationMs);
    },
    recordDeliveryRetry() {
      deliveryRetries += 1;
      return deliveryRetries;
    },
    snapshot() {
      return {
        incomingEvents,
        classifier: {
          runs: classifierRuns,
          failures: classifierFailures,
          latencyMs: {
            count: classifierLatencyCount,
            total: classifierLatencyTotal,
            max: classifierLatencyMax,
          },
        },
        deliveryRetries,
      };
    },
    reset() {
      incomingEvents = 0;
      classifierRuns = 0;
      classifierFailures = 0;
      classifierLatencyCount = 0;
      classifierLatencyTotal = 0;
      classifierLatencyMax = 0;
      deliveryRetries = 0;
    },
  };
}

export const operationalMetrics = createOperationalMetrics();
