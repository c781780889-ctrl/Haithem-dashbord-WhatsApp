const Service = require('./TelegramJoinAutomationService');

describe('Telegram Join Automation hardening contracts', () => {
  test('maps already participant to an idempotent success result', () => {
    expect(Service.classifyError(new Error('USER_ALREADY_PARTICIPANT'))).toMatchObject({ resultCode: 'ALREADY_MEMBER', terminal: true, membershipState: 'ALREADY_MEMBER' });
  });

  test('preserves the exact server supplied FLOOD_WAIT delay', () => {
    expect(Service.classifyError(new Error('FLOOD_WAIT_91'))).toMatchObject({ resultCode: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 91 });
  });

  test('does not allow an operation to leave PROCESSING directly for a second processing attempt', () => {
    expect(Service.operationTransitions.PROCESSING.has('PROCESSING')).toBe(false);
    expect(Service.operationTransitions.PROCESSING.has('SUCCESS')).toBe(true);
    expect(Service.operationTransitions.QUEUED.has('PROCESSING')).toBe(true);
  });

  test('job state machine only resumes paused jobs and does not revive completed jobs', () => {
    expect(Service.jobTransitions.PAUSED.has('RUNNING')).toBe(true);
    expect(Service.jobTransitions.COMPLETED.has('RUNNING')).toBe(false);
    expect(Service.jobTransitions.STOPPED.has('RUNNING')).toBe(false);
  });

  test('membership verification records evidence when Telegram returns a participant', async () => {
    const client = { getInputEntity: jest.fn().mockResolvedValue({ channel: 'input' }), getParticipant: jest.fn().mockResolvedValue({ className: 'ChannelParticipant' }) };
    await expect(Service.verifyMembership(client, { telegram_identifier: 'example', link_type: 'PUBLIC' })).resolves.toMatchObject({ verified: true, state: 'JOINED', evidence: { participantClass: 'ChannelParticipant' } });
  });

  test('membership verification does not claim success when Telegram cannot resolve membership', async () => {
    const client = { getInputEntity: jest.fn().mockRejectedValue(new Error('USER_NOT_PARTICIPANT')) };
    await expect(Service.verifyMembership(client, { telegram_identifier: 'example', link_type: 'PUBLIC' })).resolves.toMatchObject({ verified: false, state: 'NOT_VERIFIED' });
  });
});
