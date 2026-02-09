import {MobxLitElement} from '@adobe/lit-mobx';
import {CSSResultGroup, html, nothing} from 'lit';
import {customElement, property} from 'lit/decorators.js';

import '@material/web/textfield/outlined-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/switch/switch.js';
import '@material/web/divider/divider.js';

import {core} from '../../core/core';
import {ExperimentEditor} from '../../services/experiment.editor';
import {SenderReceiverStageConfig} from '@deliberation-lab/utils';
import {styles} from './sender_receiver_editor.scss';

@customElement('sender-receiver-editor')
export class SenderReceiverEditor extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];
  private readonly experimentEditor = core.getService(ExperimentEditor);

  @property() stage: SenderReceiverStageConfig | undefined = undefined;

  override render() {
    if (this.stage === undefined) return nothing;

    return html`
      <div class="editor-container">
        <div class="section-header">
          <div class="title">General Settings</div>
        </div>
        <div class="settings-row">
          ${this.renderNumberInput('Total Rounds', 'numRounds')}
          ${this.renderNumberInput(
            'True State 1 Probability (0.0-1.0)',
            'state1Probability',
          )}
        </div>
        <div class="settings-row">
          ${this.renderNumberInput(
            'Sender Time Limit in Seconds (0 = no limit)',
            'senderTimeLimitInSeconds',
          )}
          ${this.renderNumberInput(
            'Receiver Time Limit in Seconds (0 = no limit)',
            'receiverTimeLimitInSeconds',
          )}
        </div>

        <div class="section-header">
          <div class="title">Customize Labels Shown to Participants</div>
        </div>
        <div class="label-group">
          <div class="group-subtitle">Sender & Receiver Names</div>
          <div class="settings-row">
            ${this.renderTextInput('Sender Name', 'SenderLabel')}
            ${this.renderTextInput('Receiver Name', 'ReceiverLabel')}
          </div>
        </div>
        <div class="label-group">
          <div class="group-subtitle">Option Names</div>
          <div class="settings-row">
            ${this.renderTextInput('Option A Label', 'optionALabel')}
            ${this.renderTextInput('Option B Label', 'optionBLabel')}
          </div>
        </div>

        <div class="label-group">
          <div class="group-subtitle">State Names(Risk Option B)</div>
          <div class="settings-row">
            ${this.renderTextInput('True State 1 Name', 'state1Label')}
            ${this.renderTextInput('TrueState 2 Name', 'state2Label')}
          </div>
        </div>

        <div class="label-group">
          <div class="group-subtitle">Sender Signals (Message Buttons)</div>
          <div class="settings-row">
            ${this.renderTextInput('Signal 1 Label', 'senderButtonLabel1')}
            ${this.renderTextInput('Signal 2 Label', 'senderButtonLabel2')}
          </div>
        </div>

        <div class="label-group">
          <div class="group-subtitle">Receiver Decisions (Final Action)</div>
          <div class="settings-row">
            ${this.renderTextInput(
              'Action 1 (Safe Option)',
              'receiverButtonLabel1',
            )}
            ${this.renderTextInput(
              'Action 2 (Risky Option)',
              'receiverButtonLabel2',
            )}
          </div>
        </div>

        <div class="section-header">
          <div class="title">Participant Instructions</div>
        </div>
        <div class="input-stack">
          ${this.renderLargeTextArea(
            'Sender Instructions (Detailed)',
            'senderInstructionDetail',
          )}
          ${this.renderLargeTextArea(
            'Receiver Instructions (Detailed)',
            'receiverInstructionDetail',
          )}
        </div>

        <div class="section-header">
          <div class="title">Payoff Matrix Configuration</div>
        </div>
        <div class="matrix-grid">
          <div class="state-card universal-card">
            <span class="state-label"
              >SAFE OPTION (A) - UNIVERSAL BASELINE</span
            >
            <div class="input-row">
              ${this.renderNumberInput('Sender Payoff', 'payoffSenderChoiceA')}
              ${this.renderNumberInput(
                'Receiver Payoff',
                'payoffReceiverChoiceA',
              )}
            </div>
          </div>

          <div class="state-card state-1">
            <span class="state-label"
              >RISKY OPTION (B) - IF ${this.stage.state1Label}</span
            >
            <div class="input-stack">
              ${this.renderNumberInput('Sender Payoff', 'payoffSenderChoiceB1')}
              ${this.renderNumberInput(
                'Receiver Payoff',
                'payoffReceiverChoiceB1',
              )}
            </div>
          </div>

          <div class="state-card state-2">
            <span class="state-label"
              >RISKY OPTION (B) - IF ${this.stage.state2Label}</span
            >
            <div class="input-stack">
              ${this.renderNumberInput('Sender Payoff', 'payoffSenderChoiceB2')}
              ${this.renderNumberInput(
                'Receiver Payoff',
                'payoffReceiverChoiceB2',
              )}
            </div>
          </div>
        </div>

        <div class="section-header">
          <div class="title">Interaction Settings</div>
        </div>
        ${this.renderToggle(
          'Allow Direct Text',
          'allowTextMessage',
          'Sender can type custom messages.',
        )}
        ${this.renderToggle(
          'Allow Button Press',
          'allowButtonPress',
          'Sender can use signal buttons.',
        )}
        ${this.renderToggle(
          'Show Payoff Feedback',
          'showPayoffFeedback',
          'Show results after each round.',
        )}
        ${this.renderToggle(
          'Require Participant Click',
          'requireParticipantClick',
          'Require participant to click Send button',
        )}
        ${this.renderToggle(
          'Show Default Choice',
          'showSenderDefaultChoice',
          'Show sender the default choice',
        )}
        ${this.renderToggle(
          'Enable Balanced Defaults',
          'enableBalancedDefaults',
          'Pre-select options with balanced A/B distribution per state',
        )}

        <div class="section-header">
          <div class="title">Default Messages (for text mode)</div>
        </div>
        <div class="settings-row">
          ${this.renderTextInput(
            'Default Message for Option A',
            'defaultMessageForA',
          )}
          ${this.renderTextInput(
            'Default Message for Option B',
            'defaultMessageForB',
          )}
        </div>
      </div>
    `;
  }

  private renderTextInput(
    label: string,
    field: keyof SenderReceiverStageConfig,
  ) {
    return html`
      <md-outlined-text-field
        label=${label}
        .value=${this.stage?.[field]?.toString() ?? ''}
        @input=${(e: InputEvent) =>
          this.updateStage({[field]: (e.target as HTMLInputElement).value})}
      >
      </md-outlined-text-field>
    `;
  }

  private renderLargeTextArea(
    label: string,
    field: keyof SenderReceiverStageConfig,
  ) {
    return html`
      <div class="textarea-container">
        <label class="textarea-label">${label}</label>
        <textarea
          class="custom-textarea"
          .value=${this.stage?.[field]?.toString() ?? ''}
          @input=${(e: InputEvent) =>
            this.updateStage({
              [field]: (e.target as HTMLTextAreaElement).value,
            })}
          placeholder="Enter detailed instructions here..."
        ></textarea>
      </div>
    `;
  }

  private renderNumberInput(
    label: string,
    field: keyof SenderReceiverStageConfig,
  ) {
    return html`
      <md-outlined-text-field
        label=${label}
        type="number"
        .value=${this.stage?.[field]?.toString() ?? '0'}
        @input=${(e: InputEvent) =>
          this.updateStage({
            [field]: Number((e.target as HTMLInputElement).value),
          })}
      >
      </md-outlined-text-field>
    `;
  }

  private renderToggle(
    label: string,
    field: keyof SenderReceiverStageConfig,
    helper: string,
  ) {
    return html`
      <div class="switch-row">
        <div class="label-content">
          <span class="label-text">${label}</span>
          <span class="helper">${helper}</span>
        </div>
        <md-switch
          .selected=${!!this.stage?.[field]}
          @change=${(e: Event) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.updateStage({[field]: (e.target as any).selected})}
        >
        </md-switch>
      </div>
    `;
  }

  private updateStage(updates: Partial<SenderReceiverStageConfig>) {
    if (!this.stage) return;
    this.experimentEditor.updateStage({...this.stage, ...updates});
  }
}
