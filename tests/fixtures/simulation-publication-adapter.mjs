/** Synthetic transport: records actual invocations, never accesses Weibo. */
export class SimulationPublicationAdapter {
  mode = 'simulation';
  calls = [];
  constructor(scenario = 'success', timeoutMs = 1000) {
    this.scenario = scenario;
    this.timeoutMs = timeoutMs;
  }
  async send(input) {
    this.calls.push(structuredClone(input));
    if (this.scenario === 'timeout') return new Promise(() => {});
    if (this.scenario === 'response_lost') throw new Error('synthetic response lost');
    if (this.scenario === 'unknown') return { outcome: 'unknown' };
    if (this.scenario === 'failure')
      return {
        outcome: 'failed',
        code: 'SIMULATED_REJECTION',
        message: '模拟明确拒绝，尚未发布。',
      };
    return {
      outcome: 'published',
      platformPostId: 'synthetic-post',
      url: `https://weibo.com/${input.snapshot.account.platformAccountId}/syntheticpost`,
    };
  }
}
