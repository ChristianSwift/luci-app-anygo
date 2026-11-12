'use strict';
'require baseclass';

var darkPreference = window.matchMedia('(prefers-color-scheme: dark)');

function isDarkTheme() {
	// Vantage exposes the active palette, including when following the system.
	var darkMode = document.documentElement.getAttribute('data-darkmode');
	if (darkMode === 'true' || darkMode === 'false')
		return darkMode === 'true';

	// Themes such as Argon can override the system preference with CSS.
	var background = getComputedStyle(document.body).backgroundColor.match(/\d+(?:\.\d+)?/g);
	return background && background.length >= 3 && (background[3] == null || Number(background[3]) === 1)
		? (0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2] < 128)
		: darkPreference.matches;
}

function syncTheme() {
	var dark = isDarkTheme();
	document.querySelectorAll('.anygo').forEach(function(root) {
		if (root.classList.contains('anygo-dark') === dark)
			return;
		root.classList.toggle('anygo-dark', dark);
		root.dispatchEvent(new Event('anygo-themechange'));
	});
}

return baseclass.extend({
	loadStyles: function() {
		if (document.getElementById('anygo-css'))
			return;
		document.head.appendChild(E('link', {
			id: 'anygo-css', rel: 'stylesheet', href: L.resource('anygo/anygo.css')
		}));

		var observer = new MutationObserver(syncTheme);
		var options = { attributeFilter: [ 'data-darkmode', 'data-theme', 'class', 'style' ] };
		observer.observe(document.documentElement, options);
		observer.observe(document.body, options);
		darkPreference.addEventListener('change', syncTheme);
	},

	themeClass: function() {
		return isDarkTheme() ? 'anygo anygo-dark' : 'anygo';
	},

	button: function(label, click, attrs) {
		return E('button', Object.assign({
			type: 'button', class: 'anygo-button', click: click
		}, attrs), label);
	},

	notify: function(message, kind) {
		var stack = document.getElementById('anygo-toasts');
		if (!stack) {
			stack = E('div', { id: 'anygo-toasts', class: this.themeClass() + ' anygo-toasts' });
			document.body.appendChild(stack);
		}

		var urgent = kind === 'danger' || kind === 'warning';
		var text = E('span', { role: urgent ? 'alert' : 'status', class: 'anygo-toast-message' });
		var timer;
		var close = function() {
			window.clearTimeout(timer);
			toast.remove();
		};
		var toast = E('div', { class: 'anygo-toast anygo-toast-' + kind }, [
			text,
			this.button('×', close, { class: 'anygo-button anygo-toast-close', 'aria-label': '关闭提示' })
		]);
		stack.appendChild(toast);
		text.textContent = message;
		while (stack.childElementCount > 3)
			stack.firstElementChild.remove();
		timer = window.setTimeout(close, urgent || kind === 'info' ? 7000 : 4000);
		return close;
	}
});
