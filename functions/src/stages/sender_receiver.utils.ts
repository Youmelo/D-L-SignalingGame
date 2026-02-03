import {Timestamp} from 'firebase-admin/firestore';
import {
  SenderReceiverStagePublicData,
  SenderReceiverRoundData,
  SenderReceiverStageConfig,
  getRoundDefault,
} from '@deliberation-lab/utils';

/**
 * Checks if both roles are assigned and the game hasn't started (Round 1 missing).
 * If so, returns the update object to initialize Round 1.
 */
export function startGameIfReady(
  publicData: SenderReceiverStagePublicData,
  config: SenderReceiverStageConfig,
  stageId: string,
): Record<string, unknown> | null {
  // 1. Check if roles are filled
  if (!publicData.senderId || !publicData.receiverId) {
    return null; // Not ready
  }

  // 2. Check if already started (Round 1 exists)
  if (publicData.roundMap && publicData.roundMap[1]) {
    return null; // Already started
  }

  // 3. Initialize Round 1 with balanced state generation (first round needs WAITING_BOTH_START)
  const pairSeed = `${publicData.senderId}-${publicData.receiverId}-${stageId}`;
  const firstRound = createNewRound(1, config, pairSeed, true); // isFirstRound = true

  return {
    [`roundMap.1`]: firstRound,
    currentRound: 1,
  };
}

/**
 * Helper to create a new round object with balanced state generation
 * @param roundNumber - The round number (1-indexed)
 * @param config - Stage configuration
 * @param pairSeed - Seed for deterministic random generation
 * @param isFirstRound - Whether this is the first round (needs WAITING_BOTH_START status)
 */
export function createNewRound(
  roundNumber: number,
  config: SenderReceiverStageConfig,
  pairSeed: string,
  isFirstRound: boolean = false,
): SenderReceiverRoundData {
  // Use balanced state generation based on participant pair seed
  const roundDefaults = getRoundDefault(
    roundNumber,
    config.numRounds,
    config.state1Probability ?? 0.5,
    pairSeed,
  );
  const trueState = roundDefaults.trueState;

  // First round starts with WAITING_BOTH_START, subsequent rounds start with WAITING_SENDER_DECIDE
  const initialStatus = isFirstRound
    ? 'WAITING_BOTH_START'
    : 'WAITING_SENDER_DECIDE';

  return {
    roundNumber,
    trueState,
    status: initialStatus,

    senderLabel: null,
    senderMessage: null,
    receiverChoice: null,
    senderPayoff: null,
    receiverPayoff: null,

    defaultSenderLabel: null,
    defaultReceiverChoice: null,
    senderTimedOut: false,
    receiverTimedOut: false,

    // Ready to start flags (only used for first round)
    senderReadyStart: false,
    receiverReadyStart: false,

    // Timestamps: startTime and senderUnlockedTime will be set when both players click Start Game
    startTime: isFirstRound ? null : Timestamp.now(),
    senderUnlockedTime: isFirstRound ? null : Timestamp.now(),
    senderSubmittedTime: null,
    receiverSawMessageTime: null,
    receiverUnlockedTime: null,
    receiverSubmittedTime: null,

    senderReactionTimeSeconds: null,
    receiverReactionTimeSeconds: null,
    senderActiveTimeSeconds: null,
    receiverActiveTimeSeconds: null,
  };
}

/**
 * Calculates payoffs for a round
 */
export function calculatePayoffs(
  choice: 'A' | 'B',
  trueState: 1 | 2,
  config: SenderReceiverStageConfig,
): {senderPayoff: number; receiverPayoff: number} {
  let senderPayoff = 0;
  let receiverPayoff = 0;

  if (choice === 'A') {
    senderPayoff = config.payoffSenderChoiceA;
    receiverPayoff = config.payoffReceiverChoiceA;
  } else {
    // Choice B
    if (trueState === 1) {
      senderPayoff = config.payoffSenderChoiceB1;
      receiverPayoff = config.payoffReceiverChoiceB1;
    } else {
      senderPayoff = config.payoffSenderChoiceB2;
      receiverPayoff = config.payoffReceiverChoiceB2;
    }
  }

  return {senderPayoff, receiverPayoff};
}
