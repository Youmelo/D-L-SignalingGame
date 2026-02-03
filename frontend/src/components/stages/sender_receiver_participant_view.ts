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

  @state() chatMessageA = '';
  @state() chatMessageB = '';

  @state() hasReadInstructions = false;
  @state() hasAttemptedAutoJoin = false;
  @state() detectedPreviousRole: 'sender' | 'receiver' | null = null;
  @state() selectedOption: 'A' | 'B' | null = null;

  @state() countdownRemaining: number = 0;
  @state() partnerCountdownRemaining: number = 0;
  private countdownTimer: CountdownTimer | null = null;
  private partnerCountdownInterval: ReturnType<typeof setInterval> | null =
    null;
  private lastRoundForTimer: number = 0;
  private lastStatusForTimer: string = '';
  private lastRoundForDefaults: number = 0;
  private lastRoundForSawMessage: number = 0;

  // Track page render time for active time calculation
  private pageRenderTimestamp: number = 0;
  private lastRoundForPageRender: number = 0;
  private lastStatusForPageRender: string = '';

  override disconnectedCallback() {
    super.disconnectedCallback();
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

    // Check if it's my turn or partner's turn
    const isMyTurn =
      (isSender && round.status === 'WAITING_SENDER_DECIDE') ||
      (isReceiver && round.status === 'WAITING_RECEIVER_DECIDE');

    const isPartnersTurn =
      (isSender && round.status === 'WAITING_RECEIVER_DECIDE') ||
      (isReceiver && round.status === 'WAITING_SENDER_DECIDE');

    const timerKey = `${publicData.currentRound}-${round.status}`;
    if (
      (isMyTurn || isPartnersTurn) &&
      timerKey !== `${this.lastRoundForTimer}-${this.lastStatusForTimer}`
    ) {
      this.lastRoundForTimer = publicData.currentRound;
      this.lastStatusForTimer = round.status;
      this.initCountdownForRound(round, isSender, publicData);
    }

    if (!isMyTurn && this.countdownTimer?.isRunning()) {
      this.countdownTimer.stop();
    }

    if (!isPartnersTurn && this.partnerCountdownInterval) {
      clearInterval(this.partnerCountdownInterval);
      this.partnerCountdownInterval = null;
      this.partnerCountdownRemaining = 0;
    }

    // Record page render time for active time calculation (reset on new round/status)
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

    // Record when receiver first sees the message
    if (
      isReceiver &&
      round.status === 'WAITING_RECEIVER_DECIDE' &&
      !round.receiverSawMessageTime &&
      publicData.currentRound !== this.lastRoundForSawMessage
    ) {
      this.lastRoundForSawMessage = publicData.currentRound;
      this.recordReceiverSawMessage();
    }

    if (publicData.currentRound !== this.lastRoundForDefaults) {
      this.lastRoundForDefaults = publicData.currentRound;
      this.selectedOption = null;
      this.chatMessageA = '';
      this.chatMessageB = '';
    }

    if (this.selectedOption === null && this.stage?.enableBalancedDefaults) {
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
    this.countdownTimer?.stop();
    if (this.partnerCountdownInterval) {
      clearInterval(this.partnerCountdownInterval);
      this.partnerCountdownInterval = null;
    }

    // Get role-specific time limits
    const senderTimeLimit = this.stage?.senderTimeLimitInSeconds ?? 0;
    const receiverTimeLimit = this.stage?.receiverTimeLimitInSeconds ?? 0;

    const myTimeLimit = isSender ? senderTimeLimit : receiverTimeLimit;
    const partnerTimeLimit = isSender ? receiverTimeLimit : senderTimeLimit;

    // Initialize my own countdown (only if I'm the one who should be acting)
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

    // Initialize partner's countdown display (using interval to update every second)
    const isPartnersTurn =
      (isSender && round.status === 'WAITING_RECEIVER_DECIDE') ||
      (!isSender && round.status === 'WAITING_SENDER_DECIDE');

    if (isPartnersTurn && partnerTimeLimit && partnerTimeLimit > 0) {
      const partnerStartTimestamp = isSender
        ? round.receiverUnlockedTime
        : round.senderUnlockedTime;
      if (partnerStartTimestamp) {
        // Calculate and update partner's remaining time
        const updatePartnerCountdown = () => {
          const elapsed = getTimeElapsed(partnerStartTimestamp, 's');
          const remaining = Math.max(0, partnerTimeLimit - elapsed);
          this.partnerCountdownRemaining = Math.ceil(remaining);

          if (remaining <= 0 && this.partnerCountdownInterval) {
            clearInterval(this.partnerCountdownInterval);
            this.partnerCountdownInterval = null;
          }
        };

        // Initial update
        updatePartnerCountdown();

        // Update every second
        this.partnerCountdownInterval = setInterval(
          updatePartnerCountdown,
          1000,
        );
      }
    }
  }

  private handleTimeoutSubmit(isSender: boolean) {
    const choice = this.selectedOption ?? 'A';
    if (isSender) {
      const msg = choice === 'A' ? this.chatMessageA : this.chatMessageB;
      this.handleSenderSignalWithText(choice, msg, true, this.selectedOption);
    } else {
      this.handleReceiverChoice(choice, true, this.selectedOption);
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
            <md-icon class="loading-icon">sync</md-icon>
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
            <div class="icon-wrapper">
              <md-icon class="waiting-icon">hourglass_empty</md-icon>
            </div>
          </div>
        `;
      }
      return html`<div>Loading the round data...</div>`;
    }

    // Check if waiting for both players to start
    if (round.status === 'WAITING_BOTH_START') {
      return this.renderWaitingBothStart(round, isSender);
    }

    // 4. Game Panel
    return isSender
      ? this.renderSenderPanel(round, isSender)
      : this.renderReceiverPanel(round, isReceiver);
  }

  // --- Render Waiting for Both Start ---
  private renderWaitingBothStart(
    round: SenderReceiverRoundData,
    isSender: boolean,
  ) {
    const amIReady = isSender
      ? round.senderReadyStart
      : round.receiverReadyStart;
    const partnerReady = isSender
      ? round.receiverReadyStart
      : round.senderReadyStart;
    const roleLabel = isSender ? 'Sender' : 'Receiver';

    return html`
      <div class="waiting-screen start-game-screen">
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
          ? html`
              <div class="waiting-for-partner">
                <md-icon class="waiting-icon">hourglass_empty</md-icon>
                <p>Waiting for your partner to start...</p>
              </div>
            `
          : html`
              <md-filled-button
                @click=${() => this.handleStartGame()}
                ?disabled=${this.isSignalingLoading}
              >
                ${this.isSignalingLoading ? 'Starting...' : 'Start Game'}
              </md-filled-button>
            `}
      </div>
    `;
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

  private async handleStartGame() {
    if (this.isSignalingLoading) return;
    this.isSignalingLoading = true;

    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'start_game',
        payload: {
          participantId: this.participantService.profile?.publicId,
        },
      });
      console.log('[View] Start game request successfully sent.');
    } catch (e) {
      console.error('[View] Failed to start game:', e);
    } finally {
      this.isSignalingLoading = false;
    }
  }

  // --- Helper Render Functions ---

  private renderCountdown() {
    if (this.countdownRemaining <= 0) {
      return nothing;
    }
    const isUrgent = this.countdownRemaining <= 10;
    return html`
      <div class="countdown-display ${isUrgent ? 'urgent' : ''}">
        <md-icon>timer</md-icon>
        <span>${formatTime(this.countdownRemaining)}</span>
      </div>
    `;
  }

  private renderPartnerCountdown(partnerLabel: string) {
    if (this.partnerCountdownRemaining <= 0) {
      return nothing;
    }
    return html`
      <div class="partner-countdown-display">
        <md-icon>hourglass_top</md-icon>
        <span
          >${partnerLabel}'s remaining time:
          ${formatTime(this.partnerCountdownRemaining)}</span
        >
      </div>
    `;
  }

  private renderStageFinished() {
    return html`
      <div class="waiting-screen">
        <h3>Block Finished</h3>
        <p>This block is over. Please proceed to the next step.</p>
        <div class="stage-finished-footer">
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
    viewerRole: 'sender' | 'receiver' = 'sender',
  ) {
    const senderLabel = this.stage?.SenderLabel ?? 'Sender';
    const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';

    // Determine labels based on viewer role
    const firstLabel =
      viewerRole === 'sender' ? 'You earn' : `${senderLabel} earns`;
    const secondLabel =
      viewerRole === 'sender' ? `${receiverLabel} earns` : 'You earn';

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
              <span>${firstLabel}:</span> <b>${payoffData.sender}</b>
            </div>
            <div class="role-payoff">
              <span>${secondLabel}:</span> <b>${payoffData.receiver}</b>
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
      case 'WAITING_BOTH_START':
        // This should be handled by renderWaitingBothStart, but add as fallback
        return this.renderWaitingBothStart(round, isSender);
      case 'WAITING_SENDER_DECIDE':
        const receiverLabelForSender = this.stage?.ReceiverLabel ?? 'Receiver';
        const optionALabel = this.stage?.optionALabel ?? 'Option A';
        const optionBLabel = this.stage?.optionBLabel ?? 'Option B';
        const currentRoundSender = this.getCurrentRound();
        const totalRoundsSender = this.stage?.numRounds ?? 1;

        return html`
          <div class="action-panel">
            <h3>Day ${currentRoundSender}/${totalRoundsSender}</h3>
            ${this.renderCountdown()}

            <p class="round-context-text">
              The <strong>${receiverLabelForSender}</strong> (your matched
              partner) will be asked to choose between
              <strong>${optionALabel}</strong> and
              <strong>${optionBLabel}</strong>. The actual state of the
              <strong>${optionBLabel}</strong> is revealed only to you, not to
              the ${receiverLabelForSender}.
            </p>

            <div class="status-reveal">
              <strong>Current State for ${optionBLabel}:</strong>
              ${currentStatusLabel}
            </div>

            <p class="action-instruction">
              ${this.stage?.allowTextMessage
                ? `Please type the message to send to the ${receiverLabelForSender}:`
                : `Please press to send the signal to the ${receiverLabelForSender}:`}
            </p>

            <div class="sender-cards-container">
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

            <div class="confirm-button-wrapper">
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
                class="primary-action-btn"
              >
                Send
              </md-filled-button>
            </div>
          </div>
        `;

      case 'WAITING_RECEIVER_DECIDE':
        const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        const currentRoundWaitSender = this.getCurrentRound();
        const totalRoundsWaitSender = this.stage?.numRounds ?? 1;
        return html`
          <div class="waiting-panel">
            <h3>
              Day ${currentRoundWaitSender}/${totalRoundsWaitSender} - Waiting
              for ${receiverLabel}...
            </h3>
            ${this.renderPartnerCountdown(receiverLabel)}
            <p>
              You have sent your market information. Waiting for the
              ${receiverLabel} to make a choice.
            </p>
          </div>
        `;

      case 'SHOW_FEEDBACK':
        const rLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        const currentRoundFeedbackSender = this.getCurrentRound();
        const totalRoundsFeedbackSender = this.stage?.numRounds ?? 1;

        const amIReadySender = round.senderReadyNext;
        const cumulativePayoffSender = this.getCumulativePayoff(true);

        return html`
          <div class="feedback-panel">
            <h3>
              Day ${currentRoundFeedbackSender}/${totalRoundsFeedbackSender}
              Results
            </h3>
            <p>The ${rLabel} chose Option ${round.receiverChoice}.</p>
            <div class="result-details">
              <div class="score-card">
                <div class="label">You earn</div>
                <div class="score"><b>${round.senderPayoff}</b></div>
              </div>
              <div class="score-card">
                <div class="label">${rLabel} earns</div>
                <div class="score"><b>${round.receiverPayoff}</b></div>
              </div>
            </div>
            <div class="cumulative-payoff">
              <span>Your Total Payoff: <b>${cumulativePayoffSender}</b></span>
            </div>
            ${isSender
              ? amIReadySender
                ? html`<div class="waiting-next-text">
                    Waiting for ${rLabel} to continue...
                  </div>`
                : html`<div class="next-round-wrapper">
                    <md-filled-button @click=${() => this.handleNextRound()}
                      >Next Round</md-filled-button
                    >
                  </div>`
              : nothing}
          </div>
        `;

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
      >
        <div class="card-header">
          <h4>${title}</h4>

          ${this.renderPayoffTable(payoffData, true, 'sender')}
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
                  @paste=${(e: ClipboardEvent) => e.preventDefault()}
                  @copy=${(e: ClipboardEvent) => e.preventDefault()}
                  @cut=${(e: ClipboardEvent) => e.preventDefault()}
                ></md-outlined-text-field>
              `
            : nothing}
          ${this.stage?.allowButtonPress
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
      case 'WAITING_BOTH_START':
        // This should be handled by renderWaitingBothStart, but add as fallback
        return this.renderWaitingBothStart(round, false);
      case 'WAITING_SENDER_DECIDE':
        const currentRoundWaitReceiver = this.getCurrentRound();
        const totalRoundsWaitReceiver = this.stage?.numRounds ?? 1;
        return html`
          <div class="waiting-panel">
            <h3>
              Day ${currentRoundWaitReceiver}/${totalRoundsWaitReceiver} -
              Waiting for ${senderLabel}...
            </h3>
            ${this.renderPartnerCountdown(senderLabel)}
            <p>
              The ${senderLabel} is reviewing the confidential information and
              deciding what market information to provide.
            </p>
          </div>
        `;
      case 'WAITING_RECEIVER_DECIDE':
        const receiverLabel = this.stage?.ReceiverLabel ?? 'Receiver';
        const optionBLabelReceiver = this.stage?.optionBLabel ?? 'Option B';
        const currentRoundReceiver = this.getCurrentRound();
        const totalRoundsReceiver = this.stage?.numRounds ?? 1;

        return html`
          <div class="action-panel">
            <h3>Day ${currentRoundReceiver}/${totalRoundsReceiver}</h3>
            ${this.renderCountdown()}

            <p class="round-context-text">
              After observing the actual state of
              <strong>${optionBLabelReceiver}</strong>, the
              <strong>${senderLabel}</strong> (your matched partner) sent you
              the following message:
            </p>

            ${round.senderLabel
              ? html`<div class="message-box">
                  ${round.senderMessage
                    ? html`<div class="sender-msg-text">
                        "${round.senderMessage}"
                      </div>`
                    : html`<strong
                        >"${round.senderLabel === 'A'
                          ? (this.stage?.senderButtonLabel1 ?? 'Signal A')
                          : (this.stage?.senderButtonLabel2 ??
                            'Signal B')}"</strong
                      >`}
                </div>`
              : nothing}

            <p class="action-instruction">Please click on your choice:</p>

            <div class="payoff-matrix-display">
              ${this.renderPayoffInfoCard(
                this.stage?.optionALabel ?? 'Option A',
                {
                  type: 'fixed',
                  sender: this.stage?.payoffSenderChoiceA,
                  receiver: this.stage?.payoffReceiverChoiceA,
                },
                'all',
                'receiver',
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
                'all',
                'receiver',
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
        const currentRoundFeedbackReceiver = this.getCurrentRound();
        const totalRoundsFeedbackReceiver = this.stage?.numRounds ?? 1;

        const amIReadyReceiver = round.receiverReadyNext;

        return html`
          <div class="feedback-panel">
            <h3>
              Day ${currentRoundFeedbackReceiver}/${totalRoundsFeedbackReceiver}
              Results
            </h3>
            <p>You chose Option ${round.receiverChoice}.</p>

            <div class="result-details">
              <div class="score-card">
                <div class="label">Your Payoff</div>
                <div class="score"><b>${round.receiverPayoff}</b></div>
              </div>
              <div class="score-card">
                <div class="label">${sLabel}'s Payoff</div>
                <div class="score"><b>${round.senderPayoff}</b></div>
              </div>
            </div>

            <div class="cumulative-payoff">
              <span
                >Your Total Payoff:
                <b>${this.getCumulativePayoff(false)}</b></span
              >
            </div>

            ${amIReadyReceiver
              ? html`<div class="waiting-next-text">
                  Waiting for ${sLabel} to continue...
                </div>`
              : html`<div class="next-round-wrapper">
                  <md-filled-button @click=${() => this.handleNextRound()}
                    >Next Round</md-filled-button
                  >
                </div>`}
          </div>
        `;
      default:
        return html`<div>Debug: Unknown status ${round.status}</div>`;
    }
  }

  private renderPayoffInfoCard(
    title: string,
    payoffData: PayoffData,
    showHighlight: boolean | 'all' = false,
    viewerRole: 'sender' | 'receiver' = 'receiver',
  ) {
    return html`
      <div class="info-card">
        <h4>${title}</h4>
        <div class="payoff-info-content">
          ${this.renderPayoffTable(payoffData, showHighlight, viewerRole)}
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

    let total = 0;
    for (const roundNum of Object.keys(publicData.roundMap)) {
      const round = publicData.roundMap[Number(roundNum)];
      if (round) {
        const payoff = isSender ? round.senderPayoff : round.receiverPayoff;
        if (payoff !== null) {
          total += payoff;
        }
      }
    }
    return total;
  }

  private getActiveTimeSeconds(): number {
    if (this.pageRenderTimestamp === 0) return 0;
    return (Date.now() - this.pageRenderTimestamp) / 1000;
  }

  private async handleSenderSignalWithText(
    label: 'A' | 'B',
    message: string,
    isTimedOut: boolean = false,
    defaultLabel: 'A' | 'B' | null = null,
  ) {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    const myId = this.participantService.profile?.publicId;
    const activeTimeSeconds = this.getActiveTimeSeconds();

    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'sender_signal',
        payload: {
          senderLabel: label,
          senderMessage: this.stage?.allowTextMessage ? message : undefined,
          participantId: myId,
          activeTimeSeconds,
          isTimedOut,
          defaultLabel,
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async handleReceiverChoice(
    choice: 'A' | 'B',
    isTimedOut: boolean = false,
    defaultChoice: 'A' | 'B' | null = null,
  ) {
    if (this.isDecidingLoading) return;
    this.isDecidingLoading = true;
    const myId = this.participantService.profile?.publicId;
    const activeTimeSeconds = this.getActiveTimeSeconds();

    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'receiver_choice',
        payload: {
          receiverChoice: choice,
          participantId: myId,
          activeTimeSeconds,
          isTimedOut,
          defaultChoice,
        },
      });
    } catch (e) {
      console.error(e);
    } finally {
      this.isDecidingLoading = false;
    }
  }

  private async recordReceiverSawMessage() {
    const myId = this.participantService.profile?.publicId;
    try {
      await this.participantService.submitSenderReceiverAction({
        stageId: this.stage!.id,
        action: 'receiver_saw_message',
        payload: {participantId: myId},
      });
    } catch (e) {
      console.error('Failed to record receiver saw message:', e);
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
