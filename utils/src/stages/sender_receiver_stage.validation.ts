import {Type, type Static} from '@sinclair/typebox';
import {StageKind} from './stage';
import {
  StageProgressConfigSchema,
  StageTextConfigSchema,
} from './stage.schemas'; // 注意检查引用路径，有些可能是 ./stage.schemas

/** Shorthand for strict TypeBox object validation */
const strict = {additionalProperties: false} as const;

/** SenderReceiver stage config validation. */
export const SenderReceiverStageConfigData = Type.Object(
  {
    id: Type.String({minLength: 1}),
    kind: Type.Literal(StageKind.SENDER_RECEIVER),
    name: Type.String({minLength: 1}),
    descriptions: Type.Ref(StageTextConfigSchema),
    progress: Type.Ref(StageProgressConfigSchema),

    // Labels
    ReceiverLabel: Type.String(),
    SenderLabel: Type.String(),
    senderInstructionDetail: Type.String(),
    receiverInstructionDetail: Type.String(),
    senderButtonLabel1: Type.String(),
    senderButtonLabel2: Type.String(),
    receiverButtonLabel1: Type.String(),
    receiverButtonLabel2: Type.String(),
    state1Label: Type.String(),
    state2Label: Type.String(),

    // Parameters
    numRounds: Type.Number(),
    state1Probability: Type.Number(),
    allowTextMessage: Type.Boolean(),
    allowButtonPress: Type.Boolean(),
    showSenderDefaultChoice: Type.Boolean(),
    showPayoffFeedback: Type.Boolean(),

    senderTimeLimitInSeconds: Type.Union([Type.Number(), Type.Null()]),
    receiverTimeLimitInSeconds: Type.Union([Type.Number(), Type.Null()]),
    enableBalancedDefaults: Type.Boolean(),
    defaultMessageForA: Type.String(),
    defaultMessageForB: Type.String(),
    defaultSenderChoice: Type.Union([
      Type.Literal('recommend_A'),
      Type.Literal('recommend_B'),
      Type.Literal('random'),
    ]),
    defaultReceiverChoice: Type.Union([
      Type.Literal('choose_A'),
      Type.Literal('choose_B'),
      Type.Literal('random'),
    ]),

    // Payoffs
    payoffSenderChoiceA: Type.Number(),
    payoffSenderChoiceB1: Type.Number(),
    payoffSenderChoiceB2: Type.Number(),
    payoffReceiverChoiceA: Type.Number(),
    payoffReceiverChoiceB1: Type.Number(),
    payoffReceiverChoiceB2: Type.Number(),
  },
  {$id: 'SenderReceiverStageConfig', ...strict},
);
