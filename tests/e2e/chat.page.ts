import type { Locator, Page } from '@playwright/test';

/** Page object for the ShopBot chat. Tests talk to intent ("ask"), not to selectors. */
export class ChatPage {
  readonly page: Page;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly provider: Locator;
  readonly suggestions: Locator;
  readonly botMessages: Locator;
  readonly userMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.input = page.getByTestId('chat-input');
    this.sendButton = page.getByTestId('send');
    this.provider = page.getByTestId('provider');
    this.suggestions = page.getByTestId('suggestions');
    this.botMessages = page.getByTestId('msg-bot');
    this.userMessages = page.getByTestId('msg-user');
  }

  get lastBotMessage(): Locator {
    return this.botMessages.last();
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  /** Sends a question and waits until the bot has replied to it. */
  async ask(question: string): Promise<void> {
    const before = await this.botMessages.count();
    await this.input.fill(question);
    await this.sendButton.click();
    await this.botMessages.nth(before).waitFor();
  }
}
