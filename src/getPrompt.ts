import app_css from './app.css';
import page_css from './page.css';
import app_html from './app.html';
import initialPrompt from './initialPrompt.md';

export function getPrompt(
	_clientId: string,
	_chatId: string,
	forkId: string,
): string {
	const combinedCss = page_css + '\n' + app_css;
	return initialPrompt
		.replaceAll('APP_CSS', combinedCss)
		.replaceAll('APP_HTML', app_html)
		.replaceAll('PpqUtcLGQdYN4oqc:FORK_ID', forkId);
}
