import {ParticipantProfileExtended} from '../participant';
import {SenderReceiverStageConfig} from './sender_receiver_stage';
import {StageConfig, StageContextData} from './stage';
import {AgentParticipantStageActions, BaseStageHandler} from './stage.handler';

export class SenderReceiverStageHandler extends BaseStageHandler {
  getAgentParticipantActionsForStage(
    participant: ParticipantProfileExtended,
    stage: StageConfig,
  ): AgentParticipantStageActions {
    // Prevent auto-skipping.
    // We keep the agent in the stage so it can be controlled via API or external scripts
    return {callApi: false, moveToNextStage: false};
  }
}
