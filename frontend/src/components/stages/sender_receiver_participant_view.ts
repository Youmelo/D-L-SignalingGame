import {MobxLitElement} from '@adobe/lit-mobx';
import {CSSResultGroup, html, nothing} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {unsafeHTML} from 'lit/directives/unsafe-html.js';

import '@material/web/button/filled-button.js';
import '@material/web/button/elevated-button.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/icon/icon.js';

import {core} from '../../core/core';
import {convertMarkdownToHTML} from '../../shared/utils';
import {CohortService} from '../../services/cohort.service';
import {ParticipantService} from '../../services/participant.service';
import {ParticipantAnswerService} from '../../services/participant.answer';
import {
  SenderReceiverStageConfig,
  SenderReceiverRoundData,
  SenderReceiverStagePublicData,
  SenderReceiverStageParticipantAnswer,
  ParticipantProfile,
  StageKind,
} from '@deliberation-lab/utils';
import {styles} from './sender_receiver_participant_view.scss';

type PayoffData =
  | {type: 'fixed'; sender: number | undefined; receiver: number | undefined}
  | {
      type: 'conditional';
      state1Sender: number | undefined;
      state1Receiver: number | undefined;
      state2Sender: number | undefined;
      state2Receiver: number | undefined;
      trueState: 1 | 2;
      state1Label: string;
      state2Label: string;
    };

@customElement('sender-receiver-participant-view')
export class SenderReceiverParticipantView extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];
  private readonly participantService = core.getService(ParticipantService);
  private readonly cohortService = core.getService(CohortService);
  private readonly participantAnswerService = core.getService(
    ParticipantAnswerService,
  );

  @property() stage: SenderReceiverStageConfig | null = null;
  @property() answer: SenderReceiverStageParticipantAnswer | null = null;

  @state() isSignalingLoading = false;
  @state() isDecidingLoading = false;
  @state() isFeedbackLoading = false;

  // Track separate messages for each option to ensure mutual exclusivity
  @state() chatMessageA = '';
  @state() chatMessageB = '';

  // Local state to show instructions once at the start
  @state() hasReadInstructions = false;
  // hasAttemptedAutoJoin is now only used to prevent repeated network calls for CURRENT stage checks
  @state() hasAttemptedAutoJoin = false;
  @state() detectedPreviousRole: 'sender' | 'receiver' | null = null;
  @state() selectedOption: 'A' | 'B' | null = null;
  // removed historyCheckComplete flag to allow continuous re-evaluation

  protected override updated() {
    // Continuously check for history as data loads.
    // We do not lock this because stagePublicDataMap updates asynchronously.
    if (this.stage && this.participantService.profile) {
      this.detectPreviousRole();
    }

    // Check if we should auto-join CURRENT stage (once per stage load)
    if (!this.hasAttemptedAutoJoin && this.stage && !this.isSignalingLoading) {
      this.checkCurrentStageAutoJoin();
    }
  }

  private detectPreviousRole() {
    const myId = this.participantService.profile?.publicId;
    if (!myId) return;

    let foundRole: 'sender' | 'receiver' | null = null;

    // 1. Search entire history for any role assignment
    for (const [sId, sData] of Object.entries(
      this.cohortService.stagePublicDataMap,
    )) {
      if (sId === this.stage!.id) continue; // Skip current
      if (sData.kind !== StageKind.SENDER_RECEIVER) continue;

      const srData = sData as SenderReceiverStagePublicData;
      if (srData.senderId === myId) foundRole = 'sender';
      if (srData.receiverId === myId) foundRole = 'receiver';
    }

    // 2. IMPORTANT: Cross-reference with CURRENT stage reality
    // If the role I *was* is now taken by someone else in THIS stage, I cannot claim it.
    const currentPublic = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    if (currentPublic) {
      if (
        foundRole === 'sender' &&
        currentPublic.senderId &&
        currentPublic.senderId !== myId
      ) {
        // Role collision: I was Sender, but Sender is taken by someone else. History assumption invalid.
        foundRole = null;
      }
      if (
        foundRole === 'receiver' &&
        currentPublic.receiverId &&
        currentPublic.receiverId !== myId
      ) {
        foundRole = null;
      }
    }

    // 3. Update state reactively
    if (this.detectedPreviousRole !== foundRole) {
      console.log(`[AutoJoin] Role history updated: ${foundRole}`);
      this.detectedPreviousRole = foundRole;
    }
  }

  private checkCurrentStageAutoJoin() {
    const publicData = this.cohortService.stagePublicDataMap[this.stage!.id] as
      | SenderReceiverStagePublicData
      | undefined;
    const myId = this.participantService.profile?.publicId;

    if (!publicData || !myId) return;

    const isSender = publicData.senderId === myId;
    const isReceiver = publicData.receiverId === myId;

    // If already assigned in this stage, mark as done
    if (isSender || isReceiver) {
      this.hasAttemptedAutoJoin = true;
      return;
    }

    // If roles are FULL, mark done so we don't retry
    if (publicData.senderId && publicData.receiverId) {
      this.hasAttemptedAutoJoin = true;
      return;
    }

    // Note: We do NOT auto-claim based on history anymore in this function.
    // We rely on user clicking "Continue" in the UI.
    // So nothing else to do here except mark as checked.
    this.hasAttemptedAutoJoin = true;
  }

  /**
   * Render Logic
   */
  override render() {
    // 1. check the stage & public data
    if (!this.stage) {
      return html`<div>Loading the content...</div>`;
    }

    const publicData = this.cohortService.stagePublicDataMap[this.stage.id];
    if (!publicData || publicData.kind !== StageKind.SENDER_RECEIVER) {
      return html`<div>Loading the public data...</div>`;
    }

    // 2. check authentication
    const myId = this.participantService.profile?.publicId;
    if (!myId) return html`<div>Loading the authentication...</div>`;

    const isSender = myId === publicData.senderId;
    const isReceiver = myId === publicData.receiverId;

    // 3. Waiting Screen (If no role assigned yet)
    if (!isSender && !isReceiver) {
      if (this.isSignalingLoading) {
        return html`
          <div class="waiting-screen">
            <p>Identifying your role and joining the game...</p>
            <md-icon
              style="font-size: 48px; color: #1a73e8; animation: spin 1s linear infinite;"
              >sync</md-icon
            >
          </div>
        `;
      }

      // Dynamic UI based on history
      const roleLabel = this.detectedPreviousRole
        ? this.detectedPreviousRole === 'sender'
          ? (this.stage?.SenderLabel ?? 'Sender')
          : (this.stage?.ReceiverLabel ?? 'Receiver')
        : null;

      const title = roleLabel ? 'Welcome Back' : '';
      const description = roleLabel
        ? html`You are still the <strong>${roleLabel}</strong>.`
        : html`Please join the game to be assigned a role.`;

      const btnLabel = roleLabel ? 'Continue' : 'Join Game';

      return html` <div class="waiting-screen">
        ${title ? html`<h3>${title}</h3>` : nothing}
        <p>${description}</p>
        <md-filled-button
          ?disabled=${this.isSignalingLoading}
          @click=${() =>
            this.assignedRole(
              publicData,
              myId,
              this.detectedPreviousRole ?? undefined,
            )}
        >
          ${btnLabel}
        </md-filled-button>
      </div>`;
    }

    // 4. Instruction Screen (Local only, shown once per session/refresh)
    if (!this.hasReadInstructions) {
      return this.renderInstructionScreen(isSender);
    }

    // 5. get current round data
    const roundNumber = publicData.currentRound ?? 1;

    // Check if stage is finished
    if (this.stage && roundNumber > this.stage.numRounds) {
      return this.renderStageFinished();
    }

    // NEW: Check if round is ready
    const round = publicData.roundMap[roundNumber];
    if (!round) {
      // If I have a role, but round isn't ready => Waiting for partner
      if (isSender || isReceiver) {
        return html`
          <div class="waiting-screen">
            <h3>Waiting for Game to Start</h3>
            <p>Waiting for other players to join...</p>
            <div style="margin-top:20px;">
              <md-icon style="font-size: 48px; color: #aaa;"
                >hourglass_empty</md-icon
              >
            </div>
          </div>
        `;
      }
      return html`<div>Loading the round data...</div>`;
    }

    // 4. Game Panel
    return isSender
      ? this.renderSenderPanel(round, isSender)
      : this.renderReceiverPanel(round, isReceiver);
  }

  // --- Network Actions ---

  private async assignedRole(
    publicData: SenderReceiverStagePublicData,
    myId: string,
    requestedRole?: 'sender' | 'receiver',
  ) {
    if (this.isSignalingLoading) return;
    if (!myId) {
      console.warn('[View] Skipping assignment: No User ID');
      return;
    }

    this.isSignalingLoading = true;
    console.log(
      `[View] Attempting to assign role for User: ${myId} (Request: ${requestedRole})`,
    );

    try {
      // Check if I can join (or if I'm auto-joining with a request)
      if (
        !publicData.senderId ||
        (!publicData.receiverId && publicData.senderId !== myId) ||
        requestedRole
      ) {
        await this.participantService.submitSenderReceiverAction({
          stageId: this.stage!.id,
          action: 'assign_role',
          payload: {
            participantId: myId,
            requestedRole, // Pass the request
          },
        });
        console.log('[View] Assign role request successfully sent.');
      } else {
        console.log('[View] Roles appear full or conflict detected. Skipping.');
      }
    } catch (e: unknown) {
      console.error('[View] Failed to assign role. Detailed Error:', e);
      const err = e as {code?: string};
      if (err.code === 'unauthenticated' || err.code === 'permission-denied') {
        console.error('[View] FATAL AUTH ERROR. Blocking further retries.');
        return;
      }
    } finally {
      if (this.isSignalingLoading) {
        this.isSignalingLoading = false;
      }
    }
  }

  // --- Helper Render Functions ---

  private renderStageFinished() {
    return html`
      <div class="waiting-screen">
        <h3>Block Finished</h3>
        <p>This block is over. Please proceed to the next step.</p>
        <div style="margin-top: 24px;">
          <md-filled-button
            @click=${() => this.participantService.progressToNextStage()}
          >
            Next Step
          </md-filled-button>
        </div>
      </div>
    `;
  }

  private renderPayoffTable(
    payoffData: PayoffData,
    highlightMode: boolean | 'all' = true,
  ) {
    const senderLabel = this.stage?.SenderLabel ?? 'Sender';
    const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';

    // Backwards compatibility for boolean: true -> 'active', false -> 'none'
    // But actually, 'active' means strictly checking trueState.
    // 'all' means highlighting everything.

    // Logic:
    // If highlightMode is 'all', always return highlight-row.
    // If highlightMode is true (sender view), return highlight-row only if matches trueState.
    // If highlightMode is false (default/fallback), return '' (neutral).

    if (payoffData.type === 'fixed') {
      const shouldHighlight = highlightMode === 'all' || highlightMode === true;
      return html`
        <div class="payoff-details-container">
          <div class="payoff-row ${shouldHighlight ? 'highlight-row' : ''}">
            <div class="role-payoff">
              <span>${senderLabel}:</span> <b>${payoffData.sender}</b>
            </div>
            <div class="role-payoff">
              <span>${receiverLabel}:</span> <b>${payoffData.receiver}</b>
            </div>
          </div>
        </div>
      `;
    } else {
      // Conditional
      const getStateClass = (state: 1 | 2) => {
        if (highlightMode === 'all') return 'highlight-row'; // NEW: Highlight all
        if (highlightMode === false) return ''; // No highlight
        // highlightMode === true (Sender View: Highlight True State Only)
        return payoffData.trueState === state ? 'highlight-row' : 'dimmed-row';
      };

      return html`
        <div class="payoff-details-container">
          <div class="payoff-row ${getStateClass(1)}">
            <div class="state-label">${payoffData.state1Label}</div>
            <div class="role-payoff">
              <span>${senderLabel}:</span> <b>${payoffData.state1Sender}</b>
            </div>
            <div class="role-payoff">
              <span>${receiverLabel}:</span> <b>${payoffData.state1Receiver}</b>
            </div>
          </div>
          <div class="payoff-row ${getStateClass(2)}">
            <div class="state-label">${payoffData.state2Label}</div>
            <div class="role-payoff">
              <span>${senderLabel}:</span> <b>${payoffData.state2Sender}</b>
            </div>
            <div class="role-payoff">
              <span>${receiverLabel}:</span> <b>${payoffData.state2Receiver}</b>
            </div>
          </div>
        </div>
      `;
    }
  }

  private renderInstructionScreen(isSender: boolean) {
    const senderLabel = this.stage?.SenderLabel ?? 'Sender';
    const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';

    const title = isSender
      ? `Instructions for ${senderLabel}`
      : `Instructions for ${receiverLabel}`;
    const content = isSender
      ? this.stage?.senderInstructionDetail
      : this.stage?.receiverInstructionDetail;

    return html`
      <div class="reading-panel">
        <h3>${title}</h3>
        <div class="instruction-box">
          ${unsafeHTML(convertMarkdownToHTML(content || ''))}
        </div>

        <div class="action-footer">
          <md-filled-button
            @click=${() => {
              this.hasReadInstructions = true;
            }}
          >
            Start Game
          </md-filled-button>
        </div>
      </div>
    `;
  }

  private renderSenderPanel(round: SenderReceiverRoundData, isSender: boolean) {
    const currentStatusLabel =
      round.trueState === 1 ? this.stage?.state1Label : this.stage?.state2Label;

    const potentialPayoffB =
      round.trueState === 1
        ? this.stage?.payoffSenderChoiceB1
        : this.stage?.payoffSenderChoiceB2;

    const senderLabel = this.stage?.SenderLabel ?? 'Sender';

    switch (round.status) {
      case 'WAITING_SENDER_READ': // Fallback if old data exists
      case 'WAITING_SENDER_DECIDE':
        return html`
          <div class="action-panel">
            <h3>Your Turn as ${senderLabel}</h3>
            <div class="instruction-box" style="margin-bottom: 20px;">
              ${unsafeHTML(
                convertMarkdownToHTML(
                  this.stage?.senderInstructionDetail || '',
                ),
              )}
            </div>

            <div class="status-reveal">
              <strong
                >Current State for
                ${this.stage?.optionBLabel ?? 'Option B'}:</strong
              >
              ${currentStatusLabel}
            </div>

            <p style="text-align:center; color:#666; margin-top:20px;">
              ${this.stage?.allowTextMessage
                ? 'Type your message in the box corresponding to the option you want to recommend.'
                : 'Choose which option to recommend.'}
            </p>

            <div
              class="cards-container"
              style="display: flex; gap: 16px; margin-top: 20px;"
            >
              ${this.renderDecisionCard(
                'A',
                this.stage?.optionALabel ?? 'Option A',
                this.stage?.senderButtonLabel1 ?? 'Signal A',
                {
                  // Payoff Data for A
                  type: 'fixed',
                  sender: this.stage?.payoffSenderChoiceA,
                  receiver: this.stage?.payoffReceiverChoiceA,
                },
              )}
              ${this.renderDecisionCard(
                'B',
                this.stage?.optionBLabel ?? 'Option B',
                this.stage?.senderButtonLabel2 ?? 'Signal B',
                {
                  // Payoff Data for B
                  type: 'conditional',
                  state1Sender: this.stage?.payoffSenderChoiceB1,
                  state1Receiver: this.stage?.payoffReceiverChoiceB1,
                  state2Sender: this.stage?.payoffSenderChoiceB2,
                  state2Receiver: this.stage?.payoffReceiverChoiceB2,
                  trueState: round.trueState,
                  state1Label: this.stage?.state1Label ?? 'State 1',
                  state2Label: this.stage?.state2Label ?? 'State 2',
                },
              )}
            </div>

            <div
              style="margin-top: 32px; display: flex; justify-content: center;"
            >
              <md-filled-button
                @click=${() => {
                  if (!this.selectedOption) return;
                  const msg =
                    this.selectedOption === 'A'
                      ? this.chatMessageA
                      : this.chatMessageB;
                  this.handleSenderSignalWithText(this.selectedOption, msg);
                }}
                ?disabled=${!this.selectedOption ||
                this.isDecidingLoading ||
                (!!this.stage?.allowTextMessage &&
                  !(
                    (this.selectedOption === 'A'
                      ? this.chatMessageA
                      : this.chatMessageB) || ''
                  ).trim())}
                style="--md-filled-button-container-color: #1a73e8; font-size: 1.1em; padding: 10px 24px;"
              >
                Confirm & Send Signal
              </md-filled-button>
            </div>
          </div>
        `;

      case 'WAITING_RECEIVER_READ':
        return html`<div class="waiting-panel">
          <h3>Message Sent</h3>
          <p>Waiting for receiver to read your message...</p>
        </div>`;

      case 'WAITING_RECEIVER_DECIDE':
        const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        return html`
          <div class="waiting-panel">
            <h3>Waiting for ${receiverLabel}...</h3>
            <p>
              You have sent your recommendation. Waiting for the
              ${receiverLabel} to make a choice.
            </p>
          </div>
        `;

      case 'SHOW_FEEDBACK':
        const rLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        const sLabel = this.stage?.SenderLabel ?? 'Sender';

        const amIReadySender = round.senderReadyNext;

        return html`
          <div class="feedback-panel">
            <h3>Round Results</h3>
            <p>The ${rLabel} chose Option ${round.receiverChoice}.</p>
            <div
              class="result-details"
              style="display:flex; justify-content:center; gap:30px; margin: 20px 0;"
            >
              <div class="score-card">
                <div class="label">Your Payoff</div>
                <div class="score"><b>${round.senderPayoff}</b></div>
              </div>
              <div class="score-card">
                <div class="label">${rLabel}'s Payoff</div>
                <div class="score"><b>${round.receiverPayoff}</b></div>
              </div>
            </div>
            ${isSender
              ? amIReadySender
                ? html`<div style="margin-top:20px; color:#666;">
                    Waiting for ${rLabel} to continue...
                  </div>`
                : html`<div style="margin-top:20px;">
                    <md-filled-button @click=${() => this.handleNextRound()}
                      >Next Round</md-filled-button
                    >
                  </div>`
              : nothing}
          </div>
        `;

      case 'SURVEY':
        return html`<div>Survey time...</div>`;

      default:
        return html`<div>Debug: Unknown Stage ${round.status}</div>`;
    }
  }

  // Integrated Card Renderer (Payoff + Input + Action)
  private renderDecisionCard(
    optionKey: 'A' | 'B',
    title: string,
    btnLabel: string,
    payoffData: PayoffData,
  ) {
    const isTyping =
      optionKey === 'A' ? !!this.chatMessageA : !!this.chatMessageB;
    const currentMessage =
      optionKey === 'A' ? this.chatMessageA : this.chatMessageB;
    const textRequiredButEmpty =
      this.stage?.allowTextMessage && !currentMessage.trim();

    const senderLabel = this.stage?.SenderLabel ?? 'Sender';
    const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';

    const isSelected = this.selectedOption === optionKey;

    return html`
      <div
        class="decision-card ${isTyping ? 'active-typing' : ''} ${isSelected
          ? 'selected-card'
          : ''}"
        style="${isSelected
          ? 'border: 2px solid #1a73e8; background-color: #f0f7ff;'
          : ''}"
      >
        <div class="card-header">
          <h4>${title}</h4>

          ${this.renderPayoffTable(payoffData, true)}
        </div>

        <div class="card-interaction">
          ${this.stage?.allowTextMessage
            ? html`
                <md-outlined-text-field
                  type="textarea"
                  rows="3"
                  label="Message for ${optionKey}"
                  class="message-input"
                  .value=${currentMessage}
                  @input=${(e: InputEvent) =>
                    this.handleTyping(
                      optionKey,
                      (e.target as HTMLInputElement).value,
                    )}
                ></md-outlined-text-field>
              `
            : nothing}
          ${this.stage?.allowButtonPress || this.stage?.allowTextMessage
            ? html`
                ${isSelected
                  ? html`
                      <md-filled-button
                        @click=${() => {
                          this.selectedOption = optionKey;
                        }}
                        class="action-btn"
                      >
                        <md-icon slot="icon">check</md-icon>
                        ${btnLabel} (Selected)
                      </md-filled-button>
                    `
                  : html`
                      <md-elevated-button
                        @click=${() => {
                          this.selectedOption = optionKey;
                        }}
                        class="action-btn"
                      >
                        ${btnLabel}
                      </md-elevated-button>
                    `}
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private renderReceiverPanel(
    round: SenderReceiverRoundData,
    isReceiver: boolean,
  ) {
    const senderLabel = this.stage?.SenderLabel ?? 'Sender';
    switch (round.status) {
      case 'WAITING_SENDER_READ':
      case 'WAITING_SENDER_DECIDE':
        return html`
          <div class="waiting-panel">
            <h3>Waiting for ${senderLabel}...</h3>
            <p>
              The ${senderLabel} is reviewing the confidential information and
              deciding what to recommend.
            </p>
          </div>
        `;
      case 'WAITING_RECEIVER_READ': // Fallback
      case 'WAITING_RECEIVER_DECIDE':
        const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        return html`
          <div class="action-panel">
            <h3>Your Turn as ${receiverLabel}</h3>
            <div class="instruction-box" style="margin-bottom: 20px;">
              ${unsafeHTML(
                convertMarkdownToHTML(
                  this.stage?.receiverInstructionDetail || '',
                ),
              )}
            </div>

            <p>Make your final decision.</p>

            ${round.senderLabel
              ? html`<div class="message-box">
                  ${senderLabel} says:
                  ${round.senderMessage
                    ? html`<div class="sender-msg-text">
                        "${round.senderMessage}"
                      </div>`
                    : html`<strong
                        >"I recommend Option ${round.senderLabel}"</strong
                      >`}
                </div>`
              : nothing}

            <div class="payoff-matrix-display">
              ${this.renderPayoffInfoCard(
                this.stage?.optionALabel ?? 'Option A',
                {
                  type: 'fixed',
                  sender: this.stage?.payoffSenderChoiceA,
                  receiver: this.stage?.payoffReceiverChoiceA,
                },
                'all', // highlight active style for fixed option (always true)
              )}
              ${this.renderPayoffInfoCard(
                this.stage?.optionBLabel ?? 'Option B',
                {
                  type: 'conditional',
                  state1Sender: this.stage?.payoffSenderChoiceB1,
                  state1Receiver: this.stage?.payoffReceiverChoiceB1,
                  state2Sender: this.stage?.payoffSenderChoiceB2,
                  state2Receiver: this.stage?.payoffReceiverChoiceB2,
                  trueState: 1, // Dummy value, ignored when showHighlight is 'all'
                  state1Label: this.stage?.state1Label ?? 'State 1',
                  state2Label: this.stage?.state2Label ?? 'State 2',
                },
                'all', // HIGHLIGHT ALL for receiver option B
              )}
            </div>

            <div class="action-area receiver-action-area">
              <h4>Make Your Choice</h4>
              <div class="button-row">
                <md-filled-button
                  class="signal-btn"
                  @click=${() => this.handleReceiverChoice('A')}
                  ?disabled=${this.isDecidingLoading}
                >
                  ${this.stage?.receiverButtonLabel1 ?? 'Choose A'}
                </md-filled-button>
                <md-filled-button
                  class="signal-btn"
                  @click=${() => this.handleReceiverChoice('B')}
                  ?disabled=${this.isDecidingLoading}
                >
                  ${this.stage?.receiverButtonLabel2 ?? 'Choose B'}
                </md-filled-button>
              </div>
            </div>
          </div>
        `;
      case 'SHOW_FEEDBACK':
        const sLabel = this.stage?.SenderLabel ?? 'Sender';
        const rLabel = this.stage?.ReceiverLabel ?? 'Receiver';

        const amIReadyReceiver = round.receiverReadyNext;

        return html`
          <div class="feedback-panel">
            <h3>Round Results</h3>
            <p>You chose Option ${round.receiverChoice}.</p>

            <div
              class="result-details"
              style="display:flex; justify-content:center; gap:30px; margin: 20px 0;"
            >
              <div class="score-card">
                <div class="label">Your Payoff</div>
                <div class="score"><b>${round.receiverPayoff}</b></div>
              </div>
              <div class="score-card">
                <div class="label">${sLabel}'s Payoff</div>
                <div class="score"><b>${round.senderPayoff}</b></div>
              </div>
            </div>

            ${amIReadyReceiver
              ? html`<div
                  class="waiting-text"
                  style="margin-top:20px; color:#666;"
                >
                  Waiting for ${sLabel} to continue...
                </div>`
              : html`<div style="margin-top:20px;">
                  <md-filled-button @click=${() => this.handleNextRound()}
                    >Next Round</md-filled-button
                  >
                </div>`}
          </div>
        `;
      case 'SURVEY':
        return html`<div>Survey time...</div>`;
      default:
        return html`<div>Debug: Unknown status ${round.status}</div>`;
    }
  }

  private renderPayoffInfoCard(
    title: string,
    payoffData: PayoffData,
    showHighlight: boolean | 'all' = false,
  ) {
    return html`
      <div class="info-card">
        <h4>${title}</h4>
        <div style="text-align: left; margin-top: 10px;">
          ${this.renderPayoffTable(payoffData, showHighlight)}
        </div>
      </div>
    `;
  }

  // --- User Interaction Handlers ---

  private handleTyping(key: 'A' | 'B', value: string) {
    if (value) this.selectedOption = key; // Auto-select when typing
    if (key === 'A') {
      this.chatMessageA = value;
      if (value) this.chatMessageB = ''; // Clear B if typing in A
    } else {
      this.chatMessageB = value;
      if (value) this.chatMessageA = ''; // Clear A if typing in B
    }
  }

  private async handleSenderSignalWithText(label: 'A' | 'B', message: string) {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    const myId = this.participantService.profile?.publicId; // Get current user ID

    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'sender_signal',
        payload: {
          senderLabel: label,
          senderMessage: this.stage?.allowTextMessage ? message : undefined,
          participantId: myId, // Add this to ensure backend identifies user correctly in debug mode
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async handleReceiverChoice(choice: 'A' | 'B') {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    const myId = this.participantService.profile?.publicId;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'receiver_choice',
        payload: {
          receiverChoice: choice,
          participantId: myId,
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async handleNextRound() {
    const myId = this.participantService.profile?.publicId;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'next_round',
        payload: {participantId: myId},
      });
    } catch (e) {
      console.error(e);
    }
  }
}
