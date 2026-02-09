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
import {CountdownTimer, formatTime} from '../../shared/countdown.utils';
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
  getRoundDefault,
  UnifiedTimestamp,
  getTimeElapsed,
} from '@deliberation-lab/utils';
import {styles} from './sender_receiver_participant_view.scss';

// --- Types ---

interface FixedPayoffData {
  type: 'fixed';
  sender: number | undefined;
  receiver: number | undefined;
}

interface ConditionalPayoffData {
  type: 'conditional';
  state1Sender: number | undefined;
  state1Receiver: number | undefined;
  state2Sender: number | undefined;
  state2Receiver: number | undefined;
  trueState: 1 | 2;
  state1Label: string;
  state2Label: string;
}

type PayoffData = FixedPayoffData | ConditionalPayoffData;
type Role = 'sender' | 'receiver';

interface LabelConfig {
  senderLabel: string;
  receiverLabel: string;
  optionALabel: string;
  optionBLabel: string;
  state1Label: string;
  state2Label: string;
}

interface RoundInfo {
  currentRound: number;
  totalRounds: number;
}

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

  // Loading states
  @state() isSignalingLoading = false;
  @state() isDecidingLoading = false;
  @state() isFeedbackLoading = false;

  // Input states
  @state() chatMessageA = '';
  @state() chatMessageB = '';
  @state() selectedOption: 'A' | 'B' | null = null;

  // Local confirmation state (for timer logic)
  @state() hasConfirmedChoice = false;
  private decisionClickTimestamp: number | null = null;

  // Lifecycle states
  @state() hasReadInstructions = false;
  @state() hasAttemptedAutoJoin = false;
  @state() detectedPreviousRole: 'sender' | 'receiver' | null = null;

  // Timer states
  @state() countdownRemaining: number = 0;
  @state() partnerCountdownRemaining: number = 0;
  private countdownTimer: CountdownTimer | null = null;
  private partnerCountdownInterval: ReturnType<typeof setInterval> | null =
    null;

  // Update trackers
  private lastRoundForTimer: number = 0;
  private lastStatusForTimer: string = '';
  private lastRoundForDefaults: number = 0;
  private lastRoundForSawMessage: number = 0;
  private lastRoundForPageRender: number = 0;
  private lastStatusForPageRender: string = '';
  private pageRenderTimestamp: number = 0;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanupTimers();
  }

  private cleanupTimers() {
    this.countdownTimer?.stop();
    if (this.partnerCountdownInterval) {
      clearInterval(this.partnerCountdownInterval);
      this.partnerCountdownInterval = null;
    }
  }

  protected override updated() {
    if (this.stage && this.participantService.profile) {
      this.detectPreviousRole();
      this.maybeInitCountdownAndDefaults();
    }

    if (!this.hasAttemptedAutoJoin && this.stage && !this.isSignalingLoading) {
      this.checkCurrentStageAutoJoin();
    }
  }

  // --- Initialization Logic ---

  private maybeInitCountdownAndDefaults() {
    const publicData = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    if (!publicData) return;

    const round = publicData.roundMap[publicData.currentRound];
    if (!round) return;

    const myId = this.participantService.profile?.publicId;
    const isSender = publicData.senderId === myId;
    const isReceiver = publicData.receiverId === myId;

    const isMyTurn =
      (isSender && round.status === 'WAITING_SENDER_DECIDE') ||
      (isReceiver && round.status === 'WAITING_RECEIVER_DECIDE');

    const isPartnersTurn =
      (isSender && round.status === 'WAITING_RECEIVER_DECIDE') ||
      (isReceiver && round.status === 'WAITING_SENDER_DECIDE');

    // Timer Init
    const timerKey = `${publicData.currentRound}-${round.status}`;
    if (
      (isMyTurn || isPartnersTurn) &&
      timerKey !== `${this.lastRoundForTimer}-${this.lastStatusForTimer}`
    ) {
      this.lastRoundForTimer = publicData.currentRound;
      this.lastStatusForTimer = round.status;
      this.initCountdownForRound(round, isSender, publicData);
    }

    // Stop invalid timers
    if (!isMyTurn && this.countdownTimer?.isRunning()) {
      this.countdownTimer.stop();
    }
    if (!isPartnersTurn && this.partnerCountdownInterval) {
      clearInterval(this.partnerCountdownInterval);
      this.partnerCountdownInterval = null;
      this.partnerCountdownRemaining = 0;
    }

    // Page Render Timestamp
    const pageRenderKey = `${publicData.currentRound}-${round.status}`;
    if (
      isMyTurn &&
      pageRenderKey !==
        `${this.lastRoundForPageRender}-${this.lastStatusForPageRender}`
    ) {
      this.lastRoundForPageRender = publicData.currentRound;
      this.lastStatusForPageRender = round.status;
      this.pageRenderTimestamp = Date.now();
    }

    // Record "Receiver Saw Message"
    if (
      isReceiver &&
      round.status === 'WAITING_RECEIVER_DECIDE' &&
      !round.receiverSawMessageTime &&
      publicData.currentRound !== this.lastRoundForSawMessage
    ) {
      this.lastRoundForSawMessage = publicData.currentRound;
      this.recordReceiverSawMessage();
    }

    // Reset Defaults on New Round
    if (publicData.currentRound !== this.lastRoundForDefaults) {
      this.lastRoundForDefaults = publicData.currentRound;
      this.selectedOption = null;
      this.chatMessageA = '';
      this.chatMessageB = '';
      this.hasConfirmedChoice = false;
      this.decisionClickTimestamp = null;
    }

    // Apply Balanced Defaults
    if (
      this.selectedOption === null &&
      this.stage?.enableBalancedDefaults &&
      this.stage?.showSenderDefaultChoice
    ) {
      const seed = `${publicData.senderId}-${publicData.receiverId}-${this.stage.id}`;
      const defaults = getRoundDefault(
        publicData.currentRound,
        this.stage.numRounds,
        this.stage.state1Probability,
        seed,
      );
      if (isSender && round.status === 'WAITING_SENDER_DECIDE') {
        this.selectedOption = defaults.senderDefault;
        if (this.stage.allowTextMessage) {
          if (defaults.senderDefault === 'A') {
            this.chatMessageA = this.stage.defaultMessageForA || '';
          } else {
            this.chatMessageB = this.stage.defaultMessageForB || '';
          }
        }
      }
      if (isReceiver && round.status === 'WAITING_RECEIVER_DECIDE') {
        this.selectedOption = defaults.receiverDefault;
      }
    }
  }

  private initCountdownForRound(
    round: SenderReceiverRoundData,
    isSender: boolean,
    publicData: SenderReceiverStagePublicData,
  ) {
    this.cleanupTimers();
    this.countdownRemaining = 0;
    this.partnerCountdownRemaining = 0;

    const senderTimeLimit = this.stage?.senderTimeLimitInSeconds ?? 0;
    const receiverTimeLimit = this.stage?.receiverTimeLimitInSeconds ?? 0;
    const myTimeLimit = isSender ? senderTimeLimit : receiverTimeLimit;
    const partnerTimeLimit = isSender ? receiverTimeLimit : senderTimeLimit;

    // My Timer
    const isMyTurn =
      (isSender && round.status === 'WAITING_SENDER_DECIDE') ||
      (!isSender && round.status === 'WAITING_RECEIVER_DECIDE');

    if (isMyTurn && myTimeLimit && myTimeLimit > 0) {
      const startTimestamp = isSender
        ? round.senderUnlockedTime
        : round.receiverUnlockedTime;
      if (startTimestamp) {
        const elapsedSeconds = getTimeElapsed(startTimestamp, 's');
        const remainingSeconds = Math.max(0, myTimeLimit - elapsedSeconds);

        if (remainingSeconds <= 0) {
          this.handleTimeoutSubmit(isSender);
          return;
        }

        this.countdownRemaining = Math.ceil(remainingSeconds);
        this.countdownTimer = new CountdownTimer({
          durationSeconds: Math.ceil(remainingSeconds),
          onTick: (remaining) => {
            this.countdownRemaining = remaining;
          },
          onComplete: () => {
            this.handleTimeoutSubmit(isSender);
          },
        });
        this.countdownTimer.start();
      }
    }

    // Partner Timer
    const isPartnersTurn =
      (isSender && round.status === 'WAITING_RECEIVER_DECIDE') ||
      (!isSender && round.status === 'WAITING_SENDER_DECIDE');

    if (isPartnersTurn && partnerTimeLimit && partnerTimeLimit > 0) {
      const partnerStartTimestamp = isSender
        ? round.receiverUnlockedTime
        : round.senderUnlockedTime;
      if (partnerStartTimestamp) {
        const updatePartnerCountdown = () => {
          const elapsed = getTimeElapsed(partnerStartTimestamp, 's');
          const remaining = Math.max(0, partnerTimeLimit - elapsed);
          this.partnerCountdownRemaining = Math.ceil(remaining);

          if (remaining <= 0 && this.partnerCountdownInterval) {
            clearInterval(this.partnerCountdownInterval);
            this.partnerCountdownInterval = null;
          }
        };
        updatePartnerCountdown();
        this.partnerCountdownInterval = setInterval(
          updatePartnerCountdown,
          1000,
        );
      }
    }
  }

  // --- Interaction Logic ---

  private isSenderRole(): boolean {
    const myId = this.participantService.profile?.publicId;
    const publicData = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    return publicData?.senderId === myId;
  }

  private handleConfirmChoice() {
    if (!this.selectedOption) return;

    const isSender = this.isSenderRole();
    const limit = isSender
      ? (this.stage?.senderTimeLimitInSeconds ?? 0)
      : (this.stage?.receiverTimeLimitInSeconds ?? 0);

    // Always record decision timestamp immediately
    this.decisionClickTimestamp = Date.now();
    this.hasConfirmedChoice = true;

    if (limit > 0) {
      // Logic: Timer active -> Wait for timer (UI locked)
    } else {
      // Logic: No timer -> Submit immediately
      this.handleTimeoutSubmit(isSender);
    }
  }

  private handleTimeoutSubmit(isSender: boolean) {
    if (!this.stage) return;

    // Case 1: User explicitly confirmed choice (either now or waiting for timer)
    if (this.hasConfirmedChoice && this.selectedOption) {
      if (isSender) {
        const msg =
          this.selectedOption === 'A' ? this.chatMessageA : this.chatMessageB;
        this.handleSenderSignalWithText(this.selectedOption, msg, false);
      } else {
        this.handleReceiverChoice(this.selectedOption, false);
      }
      return;
    }

    // Case 2: True timeout (no user action)
    let choice = this.selectedOption;
    if (isSender) {
      if (this.stage.requireParticipantClick) {
        this.handleSenderSignalWithText(null, '', true);
        this.selectedOption = null;
        return;
      }
      // Auto-default logic
      if (!choice) {
        if (this.stage.defaultSenderChoice === 'recommend_A') choice = 'A';
        else if (this.stage.defaultSenderChoice === 'recommend_B') choice = 'B';
        else choice = 'A';
      }
      const msg = choice === 'A' ? this.chatMessageA : this.chatMessageB;
      this.handleSenderSignalWithText(choice, msg, true);
    } else {
      // Receiver default
      if (!choice) choice = 'A';
      this.handleReceiverChoice(choice, true);
    }
  }

  // --- Render Methods ---

  override render() {
    if (!this.stage) return html`<div>Loading content...</div>`;

    const publicData = this.cohortService.stagePublicDataMap[this.stage.id];
    if (!publicData || publicData.kind !== StageKind.SENDER_RECEIVER) {
      return html`<div>Loading public data...</div>`;
    }

    const myId = this.participantService.profile?.publicId;
    if (!myId) return html`<div>Loading authentication...</div>`;

    const isSender = myId === publicData.senderId;
    const isReceiver = myId === publicData.receiverId;

    if (!isSender && !isReceiver)
      return this.renderRoleAssignmentScreen(publicData, myId);
    if (!this.hasReadInstructions)
      return this.renderInstructionScreen(isSender);

    const roundNumber =
      (publicData as SenderReceiverStagePublicData).currentRound ?? 1;
    if (this.stage && roundNumber > this.stage.numRounds)
      return this.renderStageFinished();

    const round = (publicData as SenderReceiverStagePublicData).roundMap[
      roundNumber
    ];
    if (!round) {
      return html` <div class="waiting-screen">
        <h3>Waiting for Game to Start</h3>
        <p>Waiting for players...</p>
        <md-icon class="waiting-icon">hourglass_empty</md-icon>
      </div>`;
    }

    if (round.status === 'WAITING_BOTH_START')
      return this.renderWaitingBothStart(round, isSender);

    return isSender
      ? this.renderSenderPanel(round, isSender)
      : this.renderReceiverPanel(round, isReceiver);
  }

  private renderSenderPanel(round: SenderReceiverRoundData, isSender: boolean) {
    const labels = this.getLabels();
    const roundInfo = this.getRoundInfo();
    const currentStatusLabel =
      round.trueState === 1 ? labels.state1Label : labels.state2Label;

    switch (round.status) {
      case 'WAITING_SENDER_DECIDE':
        return html` <div class="action-panel">
          <h3>Day ${roundInfo.currentRound}/${roundInfo.totalRounds}</h3>
          ${this.renderFixedChatWindow(round)} ${this.renderCountdown()}

          <p class="round-context-text">
            The <strong>${labels.receiverLabel}</strong> will choose between
            options. The state of <strong>${labels.optionBLabel}</strong> is
            revealed only to you.
          </p>

          <div class="status-reveal">
            <strong>Current State for ${labels.optionBLabel}:</strong>
            ${currentStatusLabel}
          </div>

          <div class="sender-cards-container">
            ${this.renderDecisionCard(
              'A',
              labels.optionALabel,
              this.stage?.senderButtonLabel1 ?? 'Signal A',
              this.getOptionAPayoff(),
              'sender',
              true,
            )}
            ${this.renderDecisionCard(
              'B',
              labels.optionBLabel,
              this.stage?.senderButtonLabel2 ?? 'Signal B',
              this.getOptionBPayoff(round.trueState),
              'sender',
              true,
            )}
          </div>

          <div class="confirm-button-wrapper">
            <md-filled-button
              @click=${() => this.handleConfirmChoice()}
              ?disabled=${!this.selectedOption ||
              this.hasConfirmedChoice ||
              this.isDecidingLoading}
              class="primary-action-btn"
            >
              ${this.hasConfirmedChoice
                ? 'Waiting for timer...'
                : 'Send Signal'}
            </md-filled-button>
          </div>
        </div>`;

      case 'WAITING_RECEIVER_DECIDE':
        return html` <div class="waiting-panel">
          <h3>
            Day ${roundInfo.currentRound}/${roundInfo.totalRounds} - Waiting for
            ${labels.receiverLabel}...
          </h3>
          ${this.renderFixedChatWindow(round)}
          ${this.renderPartnerCountdown(labels.receiverLabel)}
          <p>Waiting for ${labels.receiverLabel} to make a choice...</p>
        </div>`;

      case 'SHOW_FEEDBACK':
        if (this.stage?.showPayoffFeedback) {
          return this.renderFeedbackPanel(round, 'sender');
        } else {
          setTimeout(() => this.handleNextRound(), 0);
          return html`<div></div>`;
        }
      default:
        return html`<div>Debug: Unknown Stage ${round.status}</div>`;
    }
  }

  private renderReceiverPanel(
    round: SenderReceiverRoundData,
    isReceiver: boolean,
  ) {
    const labels = this.getLabels();
    const roundInfo = this.getRoundInfo();

    switch (round.status) {
      case 'WAITING_SENDER_DECIDE':
        return html` <div class="waiting-panel">
          <h3>
            Day ${roundInfo.currentRound}/${roundInfo.totalRounds} - Waiting for
            ${labels.senderLabel}...
          </h3>
          ${this.renderFixedChatWindow(round)}
          ${this.renderPartnerCountdown(labels.senderLabel)}
          <p>Waiting for ${labels.senderLabel} to send a message...</p>
        </div>`;

      case 'WAITING_RECEIVER_DECIDE':
        return html` <div class="action-panel">
          <h3>Day ${roundInfo.currentRound}/${roundInfo.totalRounds}</h3>
          ${this.renderCountdown()}
          <p class="round-context-text">
            After observing <strong>${labels.optionBLabel}</strong>, the
            <strong>${labels.senderLabel}</strong> sent you a message.
          </p>
          ${this.renderFixedChatWindow(round)}

          <div class="payoff-matrix-display">
            ${this.renderPayoffInfoCard(
              labels.optionALabel,
              this.getOptionAPayoff(),
              'all',
              'receiver',
            )}
            ${this.renderPayoffInfoCard(
              labels.optionBLabel,
              this.getOptionBPayoff(1),
              'all',
              'receiver',
            )}
          </div>

          <div class="action-area receiver-action-area">
            <p class="action-instruction">Please click on your choice:</p>
            <div class="button-row">
              <md-filled-button
                class="signal-btn"
                @click=${() => {
                  this.selectedOption = 'A';
                  this.handleConfirmChoice();
                }}
                ?disabled=${this.isDecidingLoading || this.hasConfirmedChoice}
              >
                ${this.hasConfirmedChoice && this.selectedOption === 'A'
                  ? 'Waiting...'
                  : (this.stage?.receiverButtonLabel1 ?? 'Choose A')}
              </md-filled-button>
              <md-filled-button
                class="signal-btn"
                @click=${() => {
                  this.selectedOption = 'B';
                  this.handleConfirmChoice();
                }}
                ?disabled=${this.isDecidingLoading || this.hasConfirmedChoice}
              >
                ${this.hasConfirmedChoice && this.selectedOption === 'B'
                  ? 'Waiting...'
                  : (this.stage?.receiverButtonLabel2 ?? 'Choose B')}
              </md-filled-button>
            </div>
          </div>
        </div>`;

      case 'SHOW_FEEDBACK':
        if (this.stage?.showPayoffFeedback) {
          return this.renderFeedbackPanel(round, 'receiver');
        } else {
          setTimeout(() => this.handleNextRound(), 0);
          return html`<div></div>`;
        }
      default:
        return html`<div>Debug: Unknown status ${round.status}</div>`;
    }
  }

  // --- Components: Cards & Tables ---

  private renderDecisionCard(
    optionKey: 'A' | 'B',
    title: string,
    btnLabel: string,
    payoffData: PayoffData,
    viewerRole: Role = 'sender',
    showTrueStateHighlight: boolean = true,
  ) {
    const isTyping =
      optionKey === 'A' ? !!this.chatMessageA : !!this.chatMessageB;
    const currentMessage =
      optionKey === 'A' ? this.chatMessageA : this.chatMessageB;
    const isSelected = this.selectedOption === optionKey;
    const highlightMode = showTrueStateHighlight ? true : 'all';

    return html` <div
      class="decision-card ${isTyping ? 'active-typing' : ''} ${isSelected
        ? 'selected-card'
        : ''}"
      style="cursor: pointer;"
      @click=${() => {
        if (!this.hasConfirmedChoice) this.selectedOption = optionKey;
      }}
    >
      <div class="card-header">
        <h4>${title}</h4>
        ${this.renderPayoffTable(payoffData, highlightMode, viewerRole)}
      </div>
      <div class="card-interaction">
        ${this.stage?.allowTextMessage
          ? html` <md-outlined-text-field
              type="textarea"
              rows="3"
              label="Recommend ${optionKey}"
              class="message-input"
              .value=${currentMessage}
              ?disabled=${this.hasConfirmedChoice}
              @click=${(e: Event) => e.stopPropagation()}
              @input=${(e: InputEvent) =>
                this.handleTyping(
                  optionKey,
                  (e.target as HTMLInputElement).value,
                )}
              @paste=${(e: ClipboardEvent) => e.preventDefault()}
              @copy=${(e: ClipboardEvent) => e.preventDefault()}
              @cut=${(e: ClipboardEvent) => e.preventDefault()}
            ></md-outlined-text-field>`
          : nothing}
        ${this.stage?.allowButtonPress
          ? html` <md-filled-button
              @click=${(e: Event) => {
                e.stopPropagation();
                if (!this.hasConfirmedChoice) this.selectedOption = optionKey;
              }}
              class="action-btn"
              ?disabled=${this.hasConfirmedChoice}
            >
              <md-icon slot="icon"
                >${isSelected
                  ? 'check_circle'
                  : 'radio_button_unchecked'}</md-icon
              >
              ${isSelected ? `${btnLabel} (Selected)` : `Select ${btnLabel}`}
            </md-filled-button>`
          : nothing}
      </div>
    </div>`;
  }

  private renderPayoffTable(
    payoffData: PayoffData,
    highlightMode: boolean | 'all' = true,
    viewerRole: Role = 'sender',
  ) {
    const labels = this.getLabels();
    const firstLabel =
      viewerRole === 'sender' ? 'You earn' : `${labels.senderLabel} earns`;
    const secondLabel =
      viewerRole === 'sender' ? `${labels.receiverLabel} earns` : 'You earn';

    if (payoffData.type === 'fixed') {
      const shouldHighlight = highlightMode === 'all' || highlightMode === true;
      return html` <div class="payoff-details-container">
        <div class="payoff-row ${shouldHighlight ? 'highlight-row' : ''}">
          <div class="role-payoff">
            <span>${firstLabel}:</span> <b>${payoffData.sender}</b>
          </div>
          <div class="role-payoff">
            <span>${secondLabel}:</span> <b>${payoffData.receiver}</b>
          </div>
        </div>
      </div>`;
    } else {
      const getStateClass = (state: 1 | 2) => {
        if (highlightMode === 'all') return 'highlight-row';
        if (highlightMode === false) return '';
        return payoffData.trueState === state ? 'highlight-row' : 'dimmed-row';
      };
      return html` <div class="payoff-details-container">
        <div class="payoff-row ${getStateClass(1)}">
          <div class="role-payoff">
            <span>${firstLabel}:</span> <b>${payoffData.state1Sender}</b>
          </div>
          <div class="role-payoff">
            <span>${secondLabel}:</span> <b>${payoffData.state1Receiver}</b>
          </div>
        </div>
        <div class="payoff-row ${getStateClass(2)}">
          <div class="role-payoff">
            <span>${firstLabel}:</span> <b>${payoffData.state2Sender}</b>
          </div>
          <div class="role-payoff">
            <span>${secondLabel}:</span> <b>${payoffData.state2Receiver}</b>
          </div>
        </div>
      </div>`;
    }
  }

  private renderRoleAssignmentScreen(
    publicData: SenderReceiverRoundData | SenderReceiverStagePublicData,
    myId: string,
  ) {
    if (this.isSignalingLoading) {
      return html` <div class="waiting-screen">
        <p>Joining game...</p>
        <md-icon class="loading-icon">sync</md-icon>
      </div>`;
    }
    const roleLabel = this.detectedPreviousRole
      ? this.detectedPreviousRole === 'sender'
        ? (this.stage?.SenderLabel ?? 'Sender')
        : (this.stage?.ReceiverLabel ?? 'Receiver')
      : null;
    const title = roleLabel ? 'Welcome Back' : '';
    const description = roleLabel
      ? html`You are still the <strong>${roleLabel}</strong>.`
      : html`Please join to be assigned a role.`;
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

  private renderInstructionScreen(isSender: boolean) {
    const labels = this.getLabels();
    const roleLabel = isSender ? labels.senderLabel : labels.receiverLabel;
    const title = `Instructions for ${roleLabel}`;
    const content = isSender
      ? this.stage?.senderInstructionDetail
      : this.stage?.receiverInstructionDetail;

    return html` <div class="reading-panel">
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
    </div>`;
  }

  private renderWaitingBothStart(
    round: SenderReceiverRoundData,
    isSender: boolean,
  ) {
    const labels = this.getLabels();
    const amIReady = isSender
      ? round.senderReadyStart
      : round.receiverReadyStart;
    const partnerReady = isSender
      ? round.receiverReadyStart
      : round.senderReadyStart;
    const roleLabel = isSender ? labels.senderLabel : labels.receiverLabel;

    return html` <div class="waiting-screen start-game-screen">
      <h3>Ready to Start?</h3>
      <p>You are the <strong>${roleLabel}</strong>.</p>
      <p>Both players must click "Start Game" to begin.</p>
      <div class="ready-status">
        <div class="status-item ${amIReady ? 'ready' : ''}">
          <md-icon
            >${amIReady ? 'check_circle' : 'radio_button_unchecked'}</md-icon
          >
          <span>You: ${amIReady ? 'Ready' : 'Not Ready'}</span>
        </div>
        <div class="status-item ${partnerReady ? 'ready' : ''}">
          <md-icon
            >${partnerReady
              ? 'check_circle'
              : 'radio_button_unchecked'}</md-icon
          >
          <span>Partner: ${partnerReady ? 'Ready' : 'Not Ready'}</span>
        </div>
      </div>
      ${amIReady
        ? html` <div class="waiting-for-partner">
            <md-icon class="waiting-icon">hourglass_empty</md-icon>
            <p>Waiting for your partner to start...</p>
          </div>`
        : html` <md-filled-button
            @click=${() => this.handleStartGame()}
            ?disabled=${this.isSignalingLoading}
          >
            ${this.isSignalingLoading ? 'Starting...' : 'Start Game'}
          </md-filled-button>`}
    </div>`;
  }

  /**
   * Render a fixed chat window that displays above the main content.
   */
  private renderFixedChatWindow(round: SenderReceiverRoundData) {
    const labels = this.getLabels();
    const senderName = labels.senderLabel;
    if (round.senderChoice === null) {
      return html`
        <div class="fixed-chat-window">
          <div class="chat-window-header">
            <md-icon>chat</md-icon>
            <span class="chat-title">Message Window</span>
          </div>
          <div class="chat-window-body">
            <div class="chat-empty-state">
              <md-icon>chat_bubble_outline</md-icon>
              <span>Waiting for message...</span>
            </div>
          </div>
        </div>
      `;
    }

    const initial = senderName.charAt(0).toUpperCase();
    const signalLabel =
      round.senderChoice === 'A'
        ? (this.stage?.senderButtonLabel1 ?? 'Signal A')
        : (this.stage?.senderButtonLabel2 ?? 'Signal B');
    const hasTextMessage = round.senderMessage && round.senderMessage.trim();

    // Display content: text message if available, otherwise signal label
    const displayContent = hasTextMessage ? round.senderMessage : signalLabel;

    return html`
      <div class="fixed-chat-window">
        <div class="chat-window-header">
          <md-icon>chat</md-icon>
          <span class="chat-title">Message Window</span>
        </div>
        <div class="chat-window-body">
          <div class="chat-message">
            <div class="avatar">${initial}</div>
            <div class="message-body">
              <span class="sender-name">${senderName}</span>
              <div class="message-text">"${displayContent}"</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderFeedbackPanel(round: SenderReceiverRoundData, myRole: Role) {
    const labels = this.getLabels();
    const roundInfo = this.getRoundInfo();
    const isSender = myRole === 'sender';
    const partnerLabel = isSender ? labels.receiverLabel : labels.senderLabel;
    const myPayoff = isSender ? round.senderPayoff : round.receiverPayoff;
    const partnerPayoff = isSender ? round.receiverPayoff : round.senderPayoff;
    const amIReady = isSender ? round.senderReadyNext : round.receiverReadyNext;
    const actionDescription = isSender
      ? `The ${partnerLabel} chose Option ${round.receiverChoice}.`
      : `You chose Option ${round.receiverChoice}.`;

    return html` <div class="feedback-panel">
      <h3>Day ${roundInfo.currentRound}/${roundInfo.totalRounds} Results</h3>
      <p>${actionDescription}</p>
      <div class="result-details">
        <div class="score-card">
          <div class="label">You earn</div>
          <div class="score"><b>${myPayoff}</b></div>
        </div>
        <div class="score-card">
          <div class="label">${partnerLabel} earns</div>
          <div class="score"><b>${partnerPayoff}</b></div>
        </div>
      </div>
      <div class="cumulative-payoff">
        <span
          >Your Total Payoff: <b>${this.getCumulativePayoff(isSender)}</b></span
        >
      </div>
      ${amIReady
        ? html`<div class="waiting-next-text">
            Waiting for ${partnerLabel} to continue...
          </div>`
        : html`<div class="next-round-wrapper">
            <md-filled-button @click=${() => this.handleNextRound()}
              >Next Round</md-filled-button
            >
          </div>`}
    </div>`;
  }

  private renderPayoffInfoCard(
    title: string,
    payoffData: PayoffData,
    showHighlight: boolean | 'all' = false,
    viewerRole: Role = 'receiver',
  ) {
    return html` <div class="info-card">
      <h4>${title}</h4>
      <div class="payoff-info-content">
        ${this.renderPayoffTable(payoffData, showHighlight, viewerRole)}
      </div>
    </div>`;
  }

  private renderCountdown() {
    if (this.countdownRemaining <= 0) return nothing;
    const isUrgent = this.countdownRemaining <= 10;
    return html` <div class="countdown-display ${isUrgent ? 'urgent' : ''}">
      <md-icon>timer</md-icon>
      <span>${formatTime(this.countdownRemaining)}</span>
    </div>`;
  }

  private renderPartnerCountdown(partnerLabel: string) {
    if (this.partnerCountdownRemaining <= 0) return nothing;
    return html` <div class="partner-countdown-display">
      <md-icon>hourglass_top</md-icon>
      <span
        >${partnerLabel}'s remaining time:
        ${formatTime(this.partnerCountdownRemaining)}</span
      >
    </div>`;
  }

  private renderStageFinished() {
    return html` <div class="waiting-screen">
      <h3>Block Finished</h3>
      <p>This block is over. Please proceed to the next step.</p>
      <div class="stage-finished-footer">
        <md-filled-button
          @click=${() => this.participantService.progressToNextStage()}
        >
          Next Step
        </md-filled-button>
      </div>
    </div>`;
  }

  // --- Helpers ---

  private getLabels(): LabelConfig {
    return {
      senderLabel: this.stage?.SenderLabel ?? 'Sender',
      receiverLabel: this.stage?.ReceiverLabel ?? 'Receiver',
      optionALabel: this.stage?.optionALabel ?? 'Option A',
      optionBLabel: this.stage?.optionBLabel ?? 'Option B',
      state1Label: this.stage?.state1Label ?? 'State 1',
      state2Label: this.stage?.state2Label ?? 'State 2',
    };
  }

  private getRoundInfo(): RoundInfo {
    return {
      currentRound: this.getCurrentRound(),
      totalRounds: this.stage?.numRounds ?? 1,
    };
  }

  private getOptionAPayoff(): FixedPayoffData {
    return {
      type: 'fixed',
      sender: this.stage?.payoffSenderChoiceA,
      receiver: this.stage?.payoffReceiverChoiceA,
    };
  }

  private getOptionBPayoff(trueState: 1 | 2): ConditionalPayoffData {
    const labels = this.getLabels();
    return {
      type: 'conditional',
      state1Sender: this.stage?.payoffSenderChoiceB1,
      state1Receiver: this.stage?.payoffReceiverChoiceB1,
      state2Sender: this.stage?.payoffSenderChoiceB2,
      state2Receiver: this.stage?.payoffReceiverChoiceB2,
      trueState,
      state1Label: labels.state1Label,
      state2Label: labels.state2Label,
    };
  }

  private getActiveTimeSeconds(): number {
    if (this.pageRenderTimestamp === 0) return 0;
    return (
      ((this.decisionClickTimestamp || Date.now()) - this.pageRenderTimestamp) /
      1000
    );
  }

  private getCurrentRound(): number {
    const publicData = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    return publicData?.currentRound ?? 1;
  }

  private getCumulativePayoff(isSender: boolean): number {
    const publicData = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    if (!publicData?.roundMap) return 0;
    return Object.values(publicData.roundMap).reduce(
      (acc, r) =>
        acc + (Number(isSender ? r.senderPayoff : r.receiverPayoff) || 0),
      0,
    );
  }

  private detectPreviousRole() {
    const myId = this.participantService.profile?.publicId;
    if (!myId) return;
    let foundRole: 'sender' | 'receiver' | null = null;
    for (const [sId, sData] of Object.entries(
      this.cohortService.stagePublicDataMap,
    )) {
      if (sId === this.stage!.id) continue;
      if (sData.kind !== StageKind.SENDER_RECEIVER) continue;
      const srData = sData as SenderReceiverStagePublicData;
      if (srData.senderId === myId) foundRole = 'sender';
      if (srData.receiverId === myId) foundRole = 'receiver';
    }
    const currentPublic = this.cohortService.stagePublicDataMap[
      this.stage!.id
    ] as SenderReceiverStagePublicData;
    if (currentPublic) {
      if (
        foundRole === 'sender' &&
        currentPublic.senderId &&
        currentPublic.senderId !== myId
      )
        foundRole = null;
      if (
        foundRole === 'receiver' &&
        currentPublic.receiverId &&
        currentPublic.receiverId !== myId
      )
        foundRole = null;
    }
    if (this.detectedPreviousRole !== foundRole)
      this.detectedPreviousRole = foundRole;
  }

  private checkCurrentStageAutoJoin() {
    const publicData = this.cohortService.stagePublicDataMap[this.stage!.id] as
      | SenderReceiverStagePublicData
      | undefined;
    const myId = this.participantService.profile?.publicId;
    if (!publicData || !myId) return;
    if (publicData.senderId === myId || publicData.receiverId === myId) {
      this.hasAttemptedAutoJoin = true;
      return;
    }
    if (publicData.senderId && publicData.receiverId) {
      this.hasAttemptedAutoJoin = true;
      return;
    }
    this.hasAttemptedAutoJoin = true;
  }

  // --- Network ---

  private async assignedRole(
    publicData: SenderReceiverRoundData | SenderReceiverStagePublicData,
    myId: string,
    requestedRole?: 'sender' | 'receiver',
  ) {
    if (this.isSignalingLoading) return;
    this.isSignalingLoading = true;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'assign_role',
        payload: {participantId: myId, requestedRole},
      });
    } catch (e) {
      console.error('[View] Failed to assign role:', e);
    } finally {
      this.isSignalingLoading = false;
    }
  }

  private async handleStartGame() {
    if (this.isSignalingLoading) return;
    this.isSignalingLoading = true;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'start_game',
        payload: {participantId: this.participantService.profile?.publicId},
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isSignalingLoading = false;
    }
  }

  private async handleSenderSignalWithText(
    label: 'A' | 'B' | null,
    message: string,
    isTimedOut: boolean,
  ) {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'sender_signal',
        payload: {
          senderChoice: label,
          senderMessage: this.stage?.allowTextMessage ? message : undefined,
          participantId: this.participantService.profile?.publicId,
          activeTimeSeconds: this.getActiveTimeSeconds(),
          isTimedOut,
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async handleReceiverChoice(choice: 'A' | 'B', isTimedOut: boolean) {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'receiver_choice',
        payload: {
          receiverChoice: choice,
          participantId: this.participantService.profile?.publicId,
          activeTimeSeconds: this.getActiveTimeSeconds(),
          isTimedOut,
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async recordReceiverSawMessage() {
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'receiver_saw_message',
        payload: {participantId: this.participantService.profile?.publicId},
      });
    } catch (e) {
      console.error(e);
    }
  }

  private async handleNextRound() {
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'next_round',
        payload: {participantId: this.participantService.profile?.publicId},
      });
    } catch (e) {
      console.error(e);
    }
  }

  private handleTyping(key: 'A' | 'B', value: string) {
    if (key === 'A') {
      this.chatMessageA = value;
      if (value) this.chatMessageB = '';
    } else {
      this.chatMessageB = value;
      if (value) this.chatMessageA = '';
    }
    if (!this.stage?.allowButtonPress) this.selectedOption = key;
  }
}
