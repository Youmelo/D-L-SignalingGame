import {generateId, UnifiedTimestamp} from '../shared';
import {
  BaseStageConfig,
  BaseStageParticipantAnswer,
  BaseStagePublicData,
  StageKind,
  createStageTextConfig,
  createStageProgressConfig,
} from './stage';

//************************************************************************* //
// INTERFACES                                                               //
// ************************************************************************* //

/**
 * Configuration for one Sender-Receiver stage
 * It's a stage that consists of multiple rounds of sender-receiver games, which can be considered as a block.
 * Control instructions for sender and receiver, signaling ways, time limits, payoff structures at the block level.
 * */
export interface SenderReceiverStageConfig extends BaseStageConfig {
  kind: StageKind.SENDER_RECEIVER;

  /*labels*/
  ReceiverLabel: string; // label for receiver role
  SenderLabel: string; // label for sender role
  senderInstructionDetail: string;
  receiverInstructionDetail: string;
  senderButtonLabel1: string; // label for option A
  senderButtonLabel2: string; // label for option B
  receiverButtonLabel1: string; // label for option A
  receiverButtonLabel2: string; // label for option B
  status1Label: string; // label for status 1 option
  status2Label: string; // label for status 2 option

  /*experiment parameters*/
  numRounds: number; // number of rounds in the stage
  status1Probability: number;
  allowTextMessage: boolean; // whether sender can write custom message
  allowButtonPress: boolean; // whether sender can select label for options
  showSenderDefaultChoice: boolean; // whether to show default choice if time limit exceeded
  showPayoffFeedback: boolean; // whether to show payoff feedback after each round

  timeLimitInMinutes: number | null; // time limit per round in minutes
  defaultSenderChoice: 'recommend_A' | 'recommend_B' | 'random';
  defaultReceiverChoice: 'choose_A' | 'choose_B' | 'random';

  /*payoff structure for the sender and receiver*/
  payoffSenderChoiceA: number; // payoff to sender if they choose option A
  payoffSenderChoiceB1: number; // payoff to sender if they choose option B(Status=1)
  payoffSenderChoiceB2: number; // payoff to sender if they choose option B(Status=2)

  payoffReceiverChoiceA: number; // payoff to receiver if they choose option A
  payoffReceiverChoiceB1: number; // payoff to receiver if they choose option B(Status=1)
  payoffReceiverChoiceB2: number; // payoff to receiver if they choose option B(Status=2)
}

/**
 * Round data contained in Sender-Receiver stage public data
 * including:
 * */
export interface SenderReceiverRoundData {
  roundNumber: number;
  trueStatus: 1 | 2; // Secret state determined by the system/referee

  /*
   * Refined status flow:
   * 1. WAITING_SENDER_READ: Sender sees the truth, but cannot submit yet.
   * 2. WAITING_SENDER_DECIDE: Sender's input is unlocked for submission.
   * 3. WAITING_RECEIVER_READ: Receiver sees the message, but cannot submit yet.
   * 4. WAITING_RECEIVER_DECIDE: Receiver's choice buttons are unlocked.
   * 5. SHOW_FEEDBACK: Round is over, results are displayed.
   * 6. SURVEY: Optional survey after the round (if any)
   */
  status:
    | 'WAITING_SENDER_READ'
    | 'WAITING_SENDER_DECIDE'
    | 'WAITING_RECEIVER_READ'
    | 'WAITING_RECEIVER_DECIDE'
    | 'SHOW_FEEDBACK'
    | 'SURVEY';

  // Player actions
  senderLabel: 'A' | 'B' | null; // Pre-defined label chosen by Sender
  senderMessage: string | null; // Custom text written by Sender
  receiverChoice: 'A' | 'B' | null; // Final decision by Receiver

  // Results for this round
  senderPayoff: number | null;
  receiverPayoff: number | null;

  // Timestamps for reaction time analysis
  startTime: UnifiedTimestamp | null; // Round starts (Start reading)
  senderUnlockedTime: UnifiedTimestamp | null; // Submit button enabled for Sender
  senderSubmittedTime: UnifiedTimestamp | null; // Sender took action
  receiverSawMessageTime: UnifiedTimestamp | null; // Message appeared for Receiver
  receiverUnlockedTime: UnifiedTimestamp | null; // Choice buttons enabled for Receiver
  receiverSubmittedTime: UnifiedTimestamp | null; // Receiver took action
}

/**
 * Public data for Sender-Receiver stage
 * */
export interface SenderReceiverStagePublicData extends BaseStagePublicData {
  kind: StageKind.SENDER_RECEIVER;

  //Role & Progress Tracking
  senderId: string | null; // Assigned participant ID for Sender
  receiverId: string | null; // Assigned participant ID for Receiver
  currentRound: number; // Current active round index (starts at 1)

  // Round Data Map
  roundMap: Record<number, SenderReceiverRoundData>;
}

/**
 * Participant answer for Sender-Receiver stage
 * */
export interface SenderReceiverStageParticipantAnswer extends BaseStageParticipantAnswer {
  kind: StageKind.SENDER_RECEIVER;
  role: 'sender' | 'receiver' | null;
  totalPayoff: number;
}

// ************************************************************************* //
// Helper Functions                                                          //
// ************************************************************************* //
/**
 * Create a default Sender-Receiver stage config
 */
export function createSenderReceiverStage(
  config: Partial<SenderReceiverStageConfig> = {},
): SenderReceiverStageConfig {
  return {
    id: config.id ?? generateId(),
    kind: StageKind.SENDER_RECEIVER,
    name: 'Sender-Receiver Game',
    descriptions: createStageTextConfig(),
    progress: createStageProgressConfig(),

    // Default Values
    numRounds: 3,
    senderInstructionDetail: 'You are the Sender.',
    receiverInstructionDetail: 'You are the Receiver.',
    status1Label: '👨‍👩‍👧‍👦High Customer Flow',
    status2Label: '🧍‍♂️Low Customer Flow',
    senderButtonLabel1: 'I recommend Option A (Safe)',
    senderButtonLabel2: 'I recommend Option B (Risky)',
    receiverButtonLabel1: 'Choose Option A (Safe)',
    receiverButtonLabel2: 'Choose Option B (Risky)',

    timeLimitInMinutes: null,
    defaultSenderChoice: 'random',
    defaultReceiverChoice: 'random',

    payoffSenderChoiceA: 30,
    payoffSenderChoiceB1: 0,
    payoffSenderChoiceB2: 20,
    payoffReceiverChoiceA: 20,
    payoffReceiverChoiceB1: 36,
    payoffReceiverChoiceB2: 4,

    ...config,
  } as SenderReceiverStageConfig;
}

/**
 * Public Data Initialization
 */
export function createSenderReceiverStagePublicData(
  id: string,
): SenderReceiverStagePublicData {
  return {
    id,
    kind: StageKind.SENDER_RECEIVER,
    senderId: null,
    receiverId: null,
    currentRound: 1, // Start from 1
    roundMap: {}, // Essential for preventing undefined errors
  };
}

/**
 * Participant Answer Initialization
 */
export function createSenderReceiverStageParticipantAnswer(
  params: Partial<SenderReceiverStageParticipantAnswer> = {},
): SenderReceiverStageParticipantAnswer {
  return {
    id: params.id ?? generateId(),
    kind: StageKind.SENDER_RECEIVER,
    role: null,
    totalPayoff: 0,
    ...params,
  };
}
