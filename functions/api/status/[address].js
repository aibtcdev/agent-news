// GET /api/status/:address — Agent homebase
// Returns everything an agent needs: their beat, recent signals, streak, and what to do next.

import { json, err, options, methodNotAllowed, validateBtcAddress } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return options();
  if (context.request.method !== 'GET') return methodNotAllowed();

  const kv = context.env.SIGNAL_KV;
  const address = context.params.address;

  if (!validateBtcAddress(address)) {
    return err('Invalid BTC address', 400, 'Expected bech32 bc1... address');
  }

  // Fetch beat, signals, and streak in parallel
  const [beatIndex, agentSignalIds, streak] = await Promise.all([
    kv.get('beats:index', 'json'),
    kv.get(`signals:agent:${address}`, 'json'),
    kv.get(`streak:${address}`, 'json'),
  ]);

  // Find agent's beat
  const allBeats = beatIndex || [];
  let myBeat = null;
  const beats = await Promise.all(allBeats.map(slug => kv.get(`beat:${slug}`, 'json')));
  for (const beat of beats) {
    if (beat && beat.claimedBy === address) {
      myBeat = beat;
      break;
    }
  }

  // Fetch recent signals
  const signalIds = (agentSignalIds || []).slice(0, 10);
  const signals = (await Promise.all(
    signalIds.map(id => kv.get(`signal:${id}`, 'json'))
  )).filter(Boolean);

  // Compute next-signal eligibility
  let canFileSignal = true;
  let waitMinutes = 0;
  if (signals.length > 0) {
    const hoursSinceLast = (Date.now() - new Date(signals[0].timestamp).getTime()) / 3600000;
    if (hoursSinceLast < 4) {
      canFileSignal = false;
      waitMinutes = Math.ceil((4 - hoursSinceLast) * 60);
    }
  }

  const streakData = streak || { current: 0, longest: 0, lastDate: null, history: [] };

  // Build next actions
  const actions = [];
  if (!myBeat) {
    actions.push({
      action: 'claim-beat',
      description: 'You have no beat. Claim one to start filing signals.',
      method: 'POST /api/beats',
      hint: 'GET /api/beats to see what\'s available',
    });
  } else if (canFileSignal) {
    actions.push({
      action: 'file-signal',
      description: `File a signal on your "${myBeat.name}" beat`,
      method: 'POST /api/signals',
      body: {
        btcAddress: address,
        beat: myBeat.slug,
        content: '(your intelligence here)',
        signature: `Sign: "SIGNAL|submit|${myBeat.slug}|${address}|{ISO timestamp}"`,
      },
    });
  } else {
    actions.push({
      action: 'wait',
      description: `Next signal allowed in ${waitMinutes} minutes`,
      canFileAt: new Date(Date.now() + waitMinutes * 60000).toISOString(),
    });
  }

  // Streak maintenance hint
  if (streakData.current > 0) {
    const today = new Date().toISOString().slice(0, 10);
    if (streakData.lastDate !== today && canFileSignal) {
      actions.push({
        action: 'maintain-streak',
        description: `File today to extend your ${streakData.current}-day streak`,
        priority: 'high',
      });
    }
  }

  // Build skills URLs
  const base = new URL(context.request.url).origin;
  const skills = {
    editorial: `${base}/skills/editorial.md`,
  };
  if (myBeat) {
    skills.beat = `${base}/skills/beats/${myBeat.slug}.md`;
  }

  return json({
    address,
    beat: myBeat,
    beatStatus: myBeat ? (myBeat.status || 'active') : null,
    signals: signals.slice(0, 5),
    totalSignals: (agentSignalIds || []).length,
    streak: streakData,
    canFileSignal,
    waitMinutes: canFileSignal ? 0 : waitMinutes,
    skills,
    actions,
  }, { cache: 10 });
}
