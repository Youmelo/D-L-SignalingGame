import {MobxLitElement} from '@adobe/lit-mobx';
import {CSSResultGroup, html, nothing} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

import {core} from '../../core/core';
import {CohortService} from '../../services/cohort.service';
import {ParticipantService} from '../../services/participant.service';
import {ParticipantAnswerService} from '../../services/participant.answer';
import {unsafeHTML} from 'lit/directives/unsafe-html';
import {
  SenderReceiverStageConfig,
  SenderReceiverRoundData,
  SenderReceiverStagePublicData,
  SenderReceiverStageParticipantAnswer,
  StageKind,
} from '@deliberation-lab/utils';
import {styles} from './sender_receiver_participant_view.scss';
import {StageBuilderDialog} from '../experiment_builder/stage_builder_dialog';

@customElement('sender-receiver-participant-view')
export class SenderReceiverParticipantView extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];
  private readonly participantService = core.getService(ParticipantService);
  private readonly cohortService = core.getService(CohortService);
  private readonly participantAnswerService = core.getService(
    ParticipantAnswerService,
  );

  private calculatePayoff(
    publicData: SenderReceiverStagePublicData,
    round: SenderReceiverRoundData,
    myRole: 'sender' | 'receiver',
  ) {}
  @property() stage: SenderReceiverStageConfig | null = null;
  @property() answer: SenderReceiverStageParticipantAnswer | null = null;

  @state() isSignalingLoading = false;
  @state() isDecidingLoading = false;
  @state() isFeedbackLoading = false;

  /**
   * create a render panel
   */
  override render() {
    if (!this.stage || !this.answer) {
      return html`<div>Loading the content...</div>`;
    }
    const publicData = this.cohortService.stagePublicDataMap[this.stage.id];
    if (!publicData || publicData.kind !== StageKind.SENDER_RECEIVER) {
      return html`<div>Loading the public data...</div>`;
    }

    const roundNumber = publicData.currentRound ?? 1;
    const round = publicData.roundMap[roundNumber];
    if (!round) return html`<div>Loading the data...</div>`;

    /*Role Assignment*/
    const myId = this.participantService.profile?.publicId;
    if (!myId) return html`<div>Loading the authentication...</div>`;
    const isSender = myId === publicData.senderId;
    const isReceiver = myId === publicData.receiverId;
    if (!isSender && !isReceiver) {
      this.assignedRole(publicData, myId);
      return html`<div>Assigning your role...</div>`;
    }

    return isSender
      ? this.renderSenderPanel(round, true)
      : this.renderReceiverPanel(round, true);
  }

  /// render functions for each status
  private renderSenderPanel(round: SenderReceiverRoundData, isSender: boolean) {
    switch (round.status) {
      case 'WAITING_SENDER_READ':
        break;
      case 'WAITING_RECEIVER_READ':
        break;
      case 'WAITING_RECEIVER_DECIDE':
        break;
      case 'SHOW_FEEDBACK':
        break;
      case 'SURVEY':
        break;
      default:
        return nothing;
    }
  }

  private renderReceiverPanel(
    round: SenderReceiverRoundData,
    isReceiver: boolean,
  ) {
    switch (round.status) {
      case 'WAITING_SENDER_READ':
        break;
      case 'WAITING_SENDER_DECIDE':
        break;
      case 'WAITING_RECEIVER_READ':
        break;
      case 'SHOW_FEEDBACK':
        break;
      case 'SURVEY':
        break;
      default:
        return nothing;
    }
  }
  /**
   * automatically assign participant's role
   */
  private async assignedRole(
    publicData: SenderReceiverStagePublicData,
    myId: string,
  ) {}

  /**
   * calculate payoff based on roles and the sender's choice
   */

  /**
   * Handle Sender's Submission action
   */
  private async handleSendChoice(choice: 'optionA' | 'optionB') {}
  /**
   * Handle Receiver's Submission action
   */
  private async handleReceiverChoice(choice: 'optionA' | 'optionB') {}

  /**
   * Handle Next Round action for Sender and Receiver
   */
  private async handleNextRound() {}
}
