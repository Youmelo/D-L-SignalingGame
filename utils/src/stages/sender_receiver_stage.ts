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

  optionALabel: string; // Title for Option A (e.g., Safe Option)
  optionBLabel: string; // Title for Option B (e.g., Risky Option)

  state1Label: string; // label for state 1 option
  state2Label: string; // label for state 2 option

  /*experiment parameters*/
  numRounds: number;
  state1Probability: number; // probability of true state being state 1
  allowTextMessage: boolean; // whether sender can write custom message
  allowButtonPress: boolean; // whether sender can select label for options
  showSenderDefaultChoice: boolean; // whether to show default choice if time limit exceeded
  showPayoffFeedback: boolean; // whether to show payoff feedback after each round

  requireParticipantClick: boolean;

  senderTimeLimitInSeconds: number | null;
  receiverTimeLimitInSeconds: number | null;
  defaultSenderChoice: 'recommend_A' | 'recommend_B' | 'random';
  defaultReceiverChoice: 'choose_A' | 'choose_B' | 'random';
  enableBalancedDefaults: boolean;
  defaultMessageForA: string;
  defaultMessageForB: string;

  /*payoff structure for the sender and receiver*/
  payoffSenderChoiceA: number; // payoff to sender if they choose option A
  payoffSenderChoiceB1: number; // payoff to sender if they choose option B(state=1)
  payoffSenderChoiceB2: number; // payoff to sender if they choose option B(state=2)

  payoffReceiverChoiceA: number; // payoff to receiver if they choose option A
  payoffReceiverChoiceB1: number; // payoff to receiver if they choose option B(state=1)
  payoffReceiverChoiceB2: number; // payoff to receiver if they choose option B(state=2)
}

/**
 * Round data contained in Sender-Receiver stage public data
 * including:
 * */
export interface SenderReceiverRoundData {
  roundNumber: number;
  trueState: 1 | 2; // Secret state determined by the system/referee

  /*
   * Refined status flow:
   * 0. WAITING_BOTH_START: Both players must click 'Start Game' to begin.
   * 1. WAITING_SENDER_DECIDE: Sender sees the truth and can submit.
   * 2. WAITING_RECEIVER_DECIDE: Receiver sees the message and can choose.
   * 3. SHOW_FEEDBACK: Round is over, results are displayed.
   */
  status:
    | 'WAITING_BOTH_START'
    | 'WAITING_SENDER_DECIDE'
    | 'WAITING_RECEIVER_DECIDE'
    | 'SHOW_FEEDBACK';

  // Ready to start game flags (for first round only)
  senderReadyStart?: boolean;
  receiverReadyStart?: boolean;

  // Player actions
  senderChoice: 'A' | 'B' | null;
  senderMessage: string | null;
  receiverChoice: 'A' | 'B' | null;

  // Default selections (pre-selected)
  defaultSenderChoice: 'A' | 'B' | null;
  defaultReceiverChoice: 'A' | 'B' | null;
  senderTimedOut: boolean;
  receiverTimedOut: boolean;

  // Results for this round
  senderPayoff: number | null;
  receiverPayoff: number | null;

  // Ready for next round flags
  senderReadyNext?: boolean;
  receiverReadyNext?: boolean;

  // Timestamps for reaction time analysis
  startTime: UnifiedTimestamp | null; // Round starts (Start reading)
  senderUnlockedTime: UnifiedTimestamp | null; // Submit button enabled for Sender
  senderSubmittedTime: UnifiedTimestamp | null; // Sender took action
  receiverSawMessageTime: UnifiedTimestamp | null; // Message appeared for Receiver
  receiverUnlockedTime: UnifiedTimestamp | null; // Choice buttons enabled for Receiver
  receiverSubmittedTime: UnifiedTimestamp | null; // Receiver took action

  // Calculated reaction times (in seconds, based on server timestamps)
  senderReactionTimeSeconds: number | null; // senderSubmittedTime - senderUnlockedTime
  receiverReactionTimeSeconds: number | null; // receiverSubmittedTime - receiverUnlockedTime

  // Active decision times (in seconds, time spent on page before submitting, excluding reload time)
  senderActiveTimeSeconds: number | null; // Time from page render to submit (sent by frontend)
  receiverActiveTimeSeconds: number | null; // Time from page render to submit (sent by frontend)
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

/**
 * Request payload for submitting an action in Sender-Receiver stage
 */
export interface SenderReceiverActionData {
  experimentId: string;
  cohortId: string;
  stageId: string;
  action:
    | 'assign_role'
    | 'start_game'
    | 'sender_signal'
    | 'receiver_saw_message'
    | 'receiver_choice'
    | 'next_round';
  payload?: {
    senderChoice?: 'A' | 'B' | null; // For sender_signal
    senderMessage?: string; // For sender_signal
    receiverChoice?: 'A' | 'B'; // For receiver_choice
    participantId?: string; // For assign_role
    requestedRole?: 'sender' | 'receiver'; // For assign_role (optional persistence)
    activeTimeSeconds?: number; // Time spent on page before submitting (for sender_signal and receiver_choice)
    isTimedOut?: boolean; // Whether the submission was due to timeout
  };
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
    numRounds: 4,
    state1Probability: 0.5,
    senderInstructionDetail: `## Role
You are an **Advisor** working with two markets. 
By advising a vendor about these markets, you earn a commission depending on the market they choose.

## Market Information
The profitability of each market varies depending on customer flow, which **only you will know in advance**.

## Time limit: 20 seconds
In each round, the system will send a message when the time limit is reached.
If no new input has been entered before that time, the system will send a pre-set option.
`,
    receiverInstructionDetail: `## Role
You are a **Vendor** choosing between two markets. 
By selecting a market, you earn a return for your products depending on the market’s customer flow.


## Market Information
The profitability of each market varies depending on customer flow, which you will learn from your **advisor’s recommendation**.

## Time limit: 20 seconds
In each round, the system will send a message when the time limit is reached.
If no new input has been entered before that time, the system will send a pre-set option.
`,

    ReceiverLabel: 'Vendor',
    SenderLabel: 'Advisor',

    state1Label: '🔴Busy',
    state2Label: '🔵Quiet',

    optionALabel: 'Alpha Market',
    optionBLabel: 'Beta Exchange',

    senderButtonLabel1: 'Alpha Market benefits you',
    senderButtonLabel2: 'Beta Exchange benefits you',
    receiverButtonLabel1: 'Choose Alpha Market',
    receiverButtonLabel2: 'Choose Beta Exchange',

    senderTimeLimitInSeconds: null,
    receiverTimeLimitInSeconds: null,
    defaultSenderChoice: 'random',
    defaultReceiverChoice: 'random',
    enableBalancedDefaults: true,
    defaultMessageForA: 'Alpha Market benefits you',
    defaultMessageForB: 'Beta Exchange benefits you',
    allowTextMessage: true,
    allowButtonPress: false,

    payoffSenderChoiceA: 30,
    payoffSenderChoiceB1: 0,
    payoffSenderChoiceB2: 20,
    payoffReceiverChoiceA: 20,
    payoffReceiverChoiceB1: 36,
    payoffReceiverChoiceB2: 4,

    requireParticipantClick: true,
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

export class SeededRandom {
  private seed: number;

  constructor(seed: string | number) {
    this.seed = typeof seed === 'string' ? this.hashString(seed) : seed;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

export interface RoundDefaults {
  round: number;
  trueState: 1 | 2;
  senderDefault: 'A' | 'B' | null;
  receiverDefault: 'A' | 'B' | null;
}

export function generateBalancedDefaults(
  numRounds: number,
  state1Probability: number,
  seed: string,
): RoundDefaults[] {
  const rng = new SeededRandom(seed);

  const numState1 = Math.round(numRounds * state1Probability);
  const numState2 = numRounds - numState1;

  const states: (1 | 2)[] = [
    ...Array(numState1).fill(1),
    ...Array(numState2).fill(2),
  ];
  const shuffledStates = rng.shuffle(states);

  const state1ACount = Math.floor(numState1 / 2);
  const state1BCount = numState1 - state1ACount;
  const state2ACount = Math.floor(numState2 / 2);
  const state2BCount = numState2 - state2ACount;

  const senderDefaultsState1: ('A' | 'B')[] = rng.shuffle([
    ...Array(state1ACount).fill('A'),
    ...Array(state1BCount).fill('B'),
  ]);
  const senderDefaultsState2: ('A' | 'B')[] = rng.shuffle([
    ...Array(state2ACount).fill('A'),
    ...Array(state2BCount).fill('B'),
  ]);

  const receiverDefaultsState1: ('A' | 'B')[] = rng.shuffle([
    ...Array(state1ACount).fill('A'),
    ...Array(state1BCount).fill('B'),
  ]);
  const receiverDefaultsState2: ('A' | 'B')[] = rng.shuffle([
    ...Array(state2ACount).fill('A'),
    ...Array(state2BCount).fill('B'),
  ]);

  let idx1 = 0,
    idx2 = 0;
  const results: RoundDefaults[] = [];

  for (let i = 0; i < numRounds; i++) {
    const state = shuffledStates[i];
    if (state === 1) {
      results.push({
        round: i + 1,
        trueState: 1,
        senderDefault: senderDefaultsState1[idx1],
        receiverDefault: receiverDefaultsState1[idx1],
      });
      idx1++;
    } else {
      results.push({
        round: i + 1,
        trueState: 2,
        senderDefault: senderDefaultsState2[idx2],
        receiverDefault: receiverDefaultsState2[idx2],
      });
      idx2++;
    }
  }

  return results;
}

export function getRoundDefault(
  roundNumber: number,
  numRounds: number,
  state1Probability: number,
  participantPairSeed: string,
): RoundDefaults {
  const allDefaults = generateBalancedDefaults(
    numRounds,
    state1Probability,
    participantPairSeed,
  );
  return allDefaults[roundNumber - 1];
}
