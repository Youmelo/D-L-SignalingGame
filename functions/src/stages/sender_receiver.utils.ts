import {Timestamp} from 'firebase-admin/firestore';
import {
  SenderReceiverStagePublicData,
  SenderReceiverRoundData,
  SenderReceiverStageConfig,
} from '@deliberation-lab/utils';

/**
 * Checks if both roles are assigned and the game hasn't started (Round 1 missing).
 * If so, returns the update object to initialize Round 1.
 */
export function startGameIfReady(
  publicData: SenderReceiverStagePublicData,
  config: SenderReceiverStageConfig,
): Record<string, unknown> | null {
  // 1. Check if roles are filled
  if (!publicData.senderId || !publicData.receiverId) {
    return null; // Not ready
  }

  // 2. Check if already started (Round 1 exists)
  if (publicData.roundMap && publicData.roundMap[1]) {
    return null; // Already started
  }

  // 3. Initialize Round 1
  const firstRound = createNewRound(1, config);

  return {
    [`roundMap.1`]: firstRound,
    currentRound: 1,
  };
}

/**
 * Helper to create a new round object
 */
export function createNewRound(
  roundNumber: number,
  config: SenderReceiverStageConfig,
): SenderReceiverRoundData {
  // Determine true state based on probability
  const isState1 = Math.random() < (config.state1Probability ?? 0.5);

  return {
    roundNumber,
    trueState: isState1 ? 1 : 2,
    status: 'WAITING_SENDER_DECIDE', // Start state - directly to simplify flow

    senderLabel: null,
    senderMessage: null,
    receiverChoice: null,
    senderPayoff: null,
    receiverPayoff: null,

    // Timestamps
    startTime: Timestamp.now(),
    senderUnlockedTime: null,
    senderSubmittedTime: null,
    receiverSawMessageTime: null,
    receiverUnlockedTime: null,
    receiverSubmittedTime: null,
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
