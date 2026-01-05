import {onCall} from 'firebase-functions/v2/https';
import {app} from '../app';

// Import necessary utils and types
import {
  SenderReceiverStagePublicData,
  SenderReceiverStageConfig,
  UnifiedTimestamp,
} from '@deliberation-lab/utils';

// Import helper functions
import {calculatePayoff, initializeNewRound} from './sender_receiver.utils';

// Import firestore
import {
  getFirestoreStagePublicDataRef,
  getFirestoreStageRef,
} from '../utils/firestore';
import {Timestamp} from 'firebase-admin/firestore';

// ************************************************************************* //
// Process sender's and receiver's Actions                                   //
// ************************************************************************* //

export const submitSenderReceiverAction = onCall(async (request) => {
  const {data} = request;

  // 1. Basic validation
  if (!data.experimentId || !data.stageId || !data.action || !data.role) {
    throw new Error('Missing required fields');
  }

  await app.firestore().runTransaction(async (transaction) => {
    // 2. Read PublicData
    const publicDataRef = getFirestoreStagePublicDataRef(
      data.experimentId,
      data.cohortId,
      data.stageId,
    );
    const publicDoc = await transaction.get(publicDataRef);
    if (!publicDoc.exists) throw new Error('Stage data not found');
    const publicData = publicDoc.data() as SenderReceiverStagePublicData;

    // 3. Read Config
    const stageRef = getFirestoreStageRef(data.experimentId, data.stageId);
    const stageDoc = await transaction.get(stageRef);
    if (!stageDoc.exists) throw new Error('Stage config not found');
    const stageConfig = stageDoc.data() as SenderReceiverStageConfig;

    // 4. Get or initialize current round
    const currentRoundIndex = publicData.currentRound;
    let currentRound = publicData.roundMap[currentRoundIndex];

    if (!currentRound) {
      currentRound = initializeNewRound(currentRoundIndex, stageConfig);
    }

    // 5. Core state machine logic
    const now = Timestamp.now() as UnifiedTimestamp;
    if (data.role === 'sender') {
      // --- Sender Turn ---
      if (currentRound.expStatus !== 'WAITING_SENDER')
        throw new Error("Not sender's turn");

      currentRound.senderChoice = data.action;
      currentRound.senderMessage = data.message || null;
      currentRound.senderSubmitTime = now;
      currentRound.expStatus = 'WAITING_RECEIVER';
    } else if (data.role === 'receiver') {
      // --- Receiver Turn ---
      if (currentRound.expStatus !== 'WAITING_RECEIVER')
        throw new Error("Not receiver's turn");

      currentRound.receiverChoice = data.action;
      currentRound.receiverSubmitTime = now;

      // Calculate payoffs
      const payoffs = calculatePayoff(
        currentRound.receiverChoice!,
        currentRound.trueStatus,
        stageConfig,
      );
      currentRound.senderPayoff = payoffs.senderPayoff;
      currentRound.receiverPayoff = payoffs.receiverPayoff;

      currentRound.expStatus = 'FEEDBACK_GIVEN';
    }

    // 6. Save updates
    transaction.update(publicDataRef, {
      [`roundMap.${currentRoundIndex}`]: currentRound,
    });
  });

  return {success: true};
});
