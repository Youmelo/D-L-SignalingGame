import {onCall} from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {Timestamp} from 'firebase-admin/firestore';
import * as functions from 'firebase-functions';
import {
  SenderReceiverStageConfig,
  SenderReceiverStagePublicData,
  SenderReceiverRoundData,
  SenderReceiverActionData,
  StageKind,
  UnifiedTimestamp, // Import UnifiedTimestamp
  getRoundDefault,
} from '@deliberation-lab/utils';

import {
  getFirestoreStage,
  getFirestoreStagePublicDataRef,
} from '../utils/firestore';

import {startGameIfReady} from './sender_receiver.utils';

/**
 * Endpoint to handle all actions for the Sender-Receiver Stage.
 * Handles role assignment, moves, and round progression.
 */
export const submitSenderReceiverAction = onCall<SenderReceiverActionData>(
  {cors: true}, // Enable CORS
  async (request) => {
    const {experimentId, cohortId, stageId, action, payload} = request.data;
    let userId = request.auth?.uid;
    // For local testing/debugging where auth might be mocked or passed in payload
    if (process.env.FUNCTIONS_EMULATOR && payload?.participantId) {
      userId = payload.participantId;
    }

    if (!userId) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'User must be logged in.',
      );
    }

    // 1. Fetch Stage Config to verify kind and get payoff rules
    const stage = await getFirestoreStage(experimentId, stageId);
    if (!stage || stage.kind !== StageKind.SENDER_RECEIVER) {
      throw new functions.https.HttpsError(
        'not-found',
        'Stage not found or invalid kind',
      );
    }
    const config = stage as SenderReceiverStageConfig;

    // 2. Run Transaction
    await admin.firestore().runTransaction(async (transaction) => {
      const publicDataRef = getFirestoreStagePublicDataRef(
        experimentId,
        cohortId,
        stageId,
      );
      const publicDoc = await transaction.get(publicDataRef);

      if (!publicDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'Public data doc does not exist',
        );
      }

      const currentPublicData =
        publicDoc.data() as SenderReceiverStagePublicData;
      const roundIndex = currentPublicData.currentRound;
      const roundData = currentPublicData.roundMap[roundIndex];

      // -- ACTION HANDLERS --

      // A. ASSIGN ROLE
      if (action === 'assign_role') {
        console.log(
          `[AssignRole] User: ${userId}, Current Sender: ${currentPublicData.senderId}, Current Receiver: ${currentPublicData.receiverId}`,
        );

        // Idempotency: if user already has a role, do nothing
        if (
          currentPublicData.senderId === userId ||
          currentPublicData.receiverId === userId
        ) {
          console.log(
            `[AssignRole] User ${userId} already has role. Aborting.`,
          ); // <--- 加这一行
          return;
        }

        const updates: Record<string, unknown> = {};
        const reqRole = payload?.requestedRole;

        // Priority Assignment logic
        let assigned = false;

        if (reqRole === 'sender' && !currentPublicData.senderId) {
          updates.senderId = userId;
          assigned = true;
        } else if (reqRole === 'receiver' && !currentPublicData.receiverId) {
          updates.receiverId = userId;
          assigned = true;
        }

        // --- NEW: Backend-side History Check ---
        // If not assigned by request, check history for continuity
        if (!assigned && !reqRole) {
          // Only check history if NO specific request was made
          // Query all publicStageData for this cohort
          const cohortPublicDataRef = admin
            .firestore()
            .collection('experiments')
            .doc(experimentId)
            .collection('cohorts')
            .doc(cohortId)
            .collection('publicStageData');

          const snapshot = await cohortPublicDataRef.get();
          let historicalRole: 'sender' | 'receiver' | null = null;

          // Look for most recent role in other SenderReceiver stages
          // (We iterate all, or could sort. Simple iteration is usually enough for finding *any* previous role)
          snapshot.forEach((doc) => {
            if (doc.id === stageId) return; // skip current
            const data = doc.data();
            if (data.kind === StageKind.SENDER_RECEIVER) {
              if (data.senderId === userId) historicalRole = 'sender';
              if (data.receiverId === userId) historicalRole = 'receiver';
            }
          });

          if (historicalRole === 'sender' && !currentPublicData.senderId) {
            console.log(
              `[AssignRole] Found historical SENDER role for ${userId}. Auto-assigning.`,
            );
            updates.senderId = userId;
            assigned = true;
          } else if (
            historicalRole === 'receiver' &&
            !currentPublicData.receiverId
          ) {
            console.log(
              `[AssignRole] Found historical RECEIVER role for ${userId}. Auto-assigning.`,
            );
            updates.receiverId = userId;
            assigned = true;
          }
        }
        // ---------------------------------------

        // FCFS Fallback if specific request not fulfilled
        // ONLY fallback if no specific role was requested.
        // If user requested 'sender' and it failed, DO NOT assigning 'receiver' automatically.
        if (!assigned && !reqRole) {
          if (!currentPublicData.senderId) {
            updates.senderId = userId;
          } else if (!currentPublicData.receiverId) {
            updates.receiverId = userId;
          } else {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'Roles are full',
            );
          }
        } else if (!assigned && reqRole) {
          // Specific request failed
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Requested role ${reqRole} is not available.`,
          );
        }

        // Check if game can start (both roles filled -> init round 1)
        const simulatedData = {...currentPublicData, ...updates};
        const startUpdates = startGameIfReady(simulatedData, config, stageId);

        if (startUpdates) {
          Object.assign(updates, startUpdates);
        }

        transaction.update(publicDataRef, updates);
        return;
      }

      // Determine Role for subsequent checks
      const isSender = currentPublicData.senderId === userId;
      const isReceiver = currentPublicData.receiverId === userId;

      console.log(
        `[Action: ${action}] Check Role: User=${userId}, Sender=${currentPublicData.senderId}, Receiver=${currentPublicData.receiverId}`,
      );

      if (!isSender && !isReceiver) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'User is not a player in this game',
        );
      }

      // Check Round Data exists
      if (!roundData) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Round data not initialized',
        );
      }

      // A2. START GAME (Both players must click to start the first round)
      if (action === 'start_game') {
        if (roundData.status !== 'WAITING_BOTH_START') {
          // Game already started or not in the right state
          return;
        }

        const updates: Record<string, unknown> = {};
        let shouldStart = false;

        if (isSender) {
          updates[`roundMap.${roundIndex}.senderReadyStart`] = true;
          // Check if receiver is already ready
          if (roundData.receiverReadyStart) {
            shouldStart = true;
          }
        } else if (isReceiver) {
          updates[`roundMap.${roundIndex}.receiverReadyStart`] = true;
          // Check if sender is already ready
          if (roundData.senderReadyStart) {
            shouldStart = true;
          }
        }

        if (shouldStart) {
          // Both players ready - start the game!
          const now = Timestamp.now();
          updates[`roundMap.${roundIndex}.status`] = 'WAITING_SENDER_DECIDE';
          updates[`roundMap.${roundIndex}.startTime`] = now;
          updates[`roundMap.${roundIndex}.senderUnlockedTime`] = now;
          console.log(`[StartGame] Both players ready. Game started!`);
        } else {
          console.log(
            `[StartGame] User ${userId} is ready. Waiting for partner.`,
          );
        }

        transaction.update(publicDataRef, updates);
        return;
      }

      // B2. SENDER SIGNAL (Skip confirm read)
      if (action === 'sender_signal') {
        if (!isSender) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only sender can signal',
          );
        }
        if (roundData.status !== 'WAITING_SENDER_DECIDE') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Not sender turn. Current status: ${roundData.status}`,
          );
        }

        const now = Timestamp.now();

        // Calculate sender reaction time in seconds
        let senderReactionTimeSeconds: number | null = null;
        if (roundData.senderUnlockedTime) {
          const unlockedMs = roundData.senderUnlockedTime.toMillis();
          const nowMs = now.toMillis();
          senderReactionTimeSeconds = (nowMs - unlockedMs) / 1000;
        }

        // Calculate default sender choice on backend (more reliable than frontend)
        let defaultSenderChoice: 'A' | 'B' | null = null;
        if (config.enableBalancedDefaults) {
          const pairSeed = `${currentPublicData.senderId}-${currentPublicData.receiverId}-${stageId}`;
          const roundDefaults = getRoundDefault(
            roundIndex,
            config.numRounds,
            config.state1Probability ?? 0.5,
            pairSeed,
          );
          defaultSenderChoice = roundDefaults.senderDefault;
        }

        // If requireParticipantClick is true and senderTimedOut is true, set both payoffs to 0
        let senderPayoff = null;
        let receiverPayoff = null;
        if (config.requireParticipantClick && payload?.isTimedOut === true) {
          senderPayoff = 0;
          receiverPayoff = 0;
        }
        const updateData: Record<string, unknown> = {
          [`roundMap.${roundIndex}.senderChoice`]:
            payload?.senderChoice || null,
          [`roundMap.${roundIndex}.senderMessage`]:
            payload?.senderMessage || null,
          [`roundMap.${roundIndex}.senderSubmittedTime`]: now,
          [`roundMap.${roundIndex}.senderReactionTimeSeconds`]:
            senderReactionTimeSeconds,
          [`roundMap.${roundIndex}.senderActiveTimeSeconds`]:
            payload?.activeTimeSeconds ?? null,
          [`roundMap.${roundIndex}.senderTimedOut`]:
            payload?.isTimedOut ?? false,
          [`roundMap.${roundIndex}.defaultSenderChoice`]: defaultSenderChoice,
          // If requireParticipantClick and timed out, set payoffs to 0
          ...(senderPayoff !== null
            ? {[`roundMap.${roundIndex}.senderPayoff`]: senderPayoff}
            : {}),
          ...(receiverPayoff !== null
            ? {[`roundMap.${roundIndex}.receiverPayoff`]: receiverPayoff}
            : {}),
          // Transition directly to Receiver Actions
          [`roundMap.${roundIndex}.status`]: 'WAITING_RECEIVER_DECIDE',
          [`roundMap.${roundIndex}.receiverUnlockedTime`]: now,
        };
        transaction.update(publicDataRef, updateData);
      }

      // B2. RECEIVER SAW MESSAGE (record timestamp when receiver first sees the message)
      if (action === 'receiver_saw_message') {
        if (!isReceiver) {
          return; // Silently ignore if not receiver
        }
        if (roundData.status !== 'WAITING_RECEIVER_DECIDE') {
          return; // Silently ignore if not in correct state
        }
        if (roundData.receiverSawMessageTime) {
          return; // Already recorded, ignore duplicate
        }
        const updateData: Record<string, unknown> = {
          [`roundMap.${roundIndex}.receiverSawMessageTime`]: Timestamp.now(),
        };
        transaction.update(publicDataRef, updateData);
      }

      // C. RECEIVER CHOICE (Skip confirm read)
      if (action === 'receiver_choice') {
        if (!isReceiver) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only receiver can choose',
          );
        }
        if (roundData.status !== 'WAITING_RECEIVER_DECIDE') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Not receiver turn',
          );
        }
        if (!payload?.receiverChoice) {
          throw new functions.https.HttpsError(
            'invalid-argument',
            'Missing choice',
          );
        }

        const choice = payload.receiverChoice;
        const state = roundData.trueState; // 1 or 2

        // Payoff Logic
        let senderPayoff = 0;
        let receiverPayoff = 0;
        // If senderChoice is null, both payoffs are 0
        if (roundData.senderChoice === null) {
          senderPayoff = 0;
          receiverPayoff = 0;
        } else if (choice === 'A') {
          senderPayoff = config.payoffSenderChoiceA;
          receiverPayoff = config.payoffReceiverChoiceA;
        } else {
          // Choice B
          if (state === 1) {
            senderPayoff = config.payoffSenderChoiceB1;
            receiverPayoff = config.payoffReceiverChoiceB1;
          } else {
            senderPayoff = config.payoffSenderChoiceB2;
            receiverPayoff = config.payoffReceiverChoiceB2;
          }
        }

        const now = Timestamp.now();

        // Calculate receiver reaction time in seconds
        let receiverReactionTimeSeconds: number | null = null;
        if (roundData.receiverUnlockedTime) {
          const unlockedMs = roundData.receiverUnlockedTime.toMillis();
          const nowMs = now.toMillis();
          receiverReactionTimeSeconds = (nowMs - unlockedMs) / 1000;
        }

        // Calculate default receiver choice on backend (more reliable than frontend)
        let defaultReceiverChoice: 'A' | 'B' | null = null;
        if (config.enableBalancedDefaults) {
          const pairSeed = `${currentPublicData.senderId}-${currentPublicData.receiverId}-${stageId}`;
          const roundDefaults = getRoundDefault(
            roundIndex,
            config.numRounds,
            config.state1Probability ?? 0.5,
            pairSeed,
          );
          defaultReceiverChoice = roundDefaults.receiverDefault;
        }

        const updateData: Record<string, unknown> = {
          [`roundMap.${roundIndex}.receiverChoice`]: choice,
          [`roundMap.${roundIndex}.receiverSubmittedTime`]: now,
          [`roundMap.${roundIndex}.receiverReactionTimeSeconds`]:
            receiverReactionTimeSeconds,
          [`roundMap.${roundIndex}.receiverActiveTimeSeconds`]:
            payload?.activeTimeSeconds ?? null,
          [`roundMap.${roundIndex}.receiverTimedOut`]:
            payload?.isTimedOut ?? false,
          [`roundMap.${roundIndex}.defaultReceiverChoice`]:
            defaultReceiverChoice,
          [`roundMap.${roundIndex}.senderPayoff`]: senderPayoff,
          [`roundMap.${roundIndex}.receiverPayoff`]: receiverPayoff,
          [`roundMap.${roundIndex}.status`]: 'SHOW_FEEDBACK',
        };
        transaction.update(publicDataRef, updateData);
      }

      // D. NEXT ROUND
      else if (action === 'next_round') {
        // Can be triggered by anyone, but usually verifies status
        if (roundData.status !== 'SHOW_FEEDBACK') {
          return;
        }

        // --- NEW: Sync Logic ---
        const isSender = currentPublicData.senderId === userId;
        const isReceiver = currentPublicData.receiverId === userId;

        let shouldAdvance = false;

        if (isSender) {
          transaction.update(publicDataRef, {
            [`roundMap.${roundIndex}.senderReadyNext`]: true,
          });
          // Check if receiver is already ready
          if (roundData.receiverReadyNext) shouldAdvance = true;
        } else if (isReceiver) {
          transaction.update(publicDataRef, {
            [`roundMap.${roundIndex}.receiverReadyNext`]: true,
          });
          // Check if sender is already ready
          if (roundData.senderReadyNext) shouldAdvance = true;
        }

        if (!shouldAdvance) {
          console.log(
            `[NextRound] User ${userId} is ready. Waiting for partner.`,
          );
          return;
        }

        console.log(`[NextRound] Both players ready. Advancing.`);
        // -----------------------

        const nextRoundIndex = roundIndex + 1;
        if (nextRoundIndex > config.numRounds) {
          // End of game: Update currentRound to indicate completion so frontend knows to show end screen.
          transaction.update(publicDataRef, {currentRound: nextRoundIndex});
          return;
        }

        // Idempotency check: if next round already created
        if (currentPublicData.roundMap[nextRoundIndex]) {
          return;
        }

        // Use balanced state generation based on participant pair seed
        const pairSeed = `${currentPublicData.senderId}-${currentPublicData.receiverId}-${stageId}`;
        const roundDefaults = getRoundDefault(
          nextRoundIndex,
          config.numRounds,
          config.state1Probability ?? 0.5,
          pairSeed,
        );
        const nextState = roundDefaults.trueState;

        const newRoundData: SenderReceiverRoundData = {
          roundNumber: nextRoundIndex,
          trueState: nextState as 1 | 2,
          // Start next round
          status: 'WAITING_SENDER_DECIDE',
          senderChoice: null,
          senderMessage: null,
          receiverChoice: null,
          senderPayoff: null,
          receiverPayoff: null,
          // Default options (will be calculated by backend)
          defaultSenderChoice: null,
          defaultReceiverChoice: null,
          senderTimedOut: false,
          receiverTimedOut: false,
          // Use firestore timestamps
          startTime: Timestamp.now() as unknown as UnifiedTimestamp,
          senderUnlockedTime: Timestamp.now() as unknown as UnifiedTimestamp,
          senderSubmittedTime: null,
          receiverSawMessageTime: null,
          receiverUnlockedTime: null,
          receiverSubmittedTime: null,
          // Reaction times will be calculated when submitted
          senderReactionTimeSeconds: null,
          receiverReactionTimeSeconds: null,
          senderActiveTimeSeconds: null,
          receiverActiveTimeSeconds: null,
        };

        const updateData: Record<string, unknown> = {
          currentRound: nextRoundIndex,
          [`roundMap.${nextRoundIndex}`]: newRoundData,
        };
        transaction.update(publicDataRef, updateData);
      }
    });

    return {success: true};
  },
);
