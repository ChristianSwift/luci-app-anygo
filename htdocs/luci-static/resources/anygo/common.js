'use strict';
'require baseclass';
'require poll';
'require rpc';

var darkPreference = window.matchMedia('(prefers-color-scheme: dark)');
var callSetupStatus = rpc.declare({ object: 'anygo', method: 'setup_status', reject: true });
var callSetupStart = rpc.declare({ object: 'anygo', method: 'setup_start', reject: true });

var setupMessages = {
	checking: '正在检查 AnyGo 服务…',
	required: '初始化完成后即可使用 AnyGo。',
	running: '正在准备运行环境并启动服务，请稍候。',
	failed: '初始化失败。可以重试，或查看路由器上的 /var/run/anygo-setup/setup.log。',
	unavailable: '无法读取 AnyGo 服务状态，正在重试…'
};

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

	guardWorker: function(renderPage) {
		var state = 'checking';
		var checking = false;
		var starting = false;
		var attempts = 0;
		var rendered = false;
		var startError = '';
		var content = E('div', { inert: '', tabindex: '-1' });
		var title = E('h2', { id: 'anygo-setup-title' }, '初始化 AnyGo');
		var message = E('p', { role: 'status' }, setupMessages.checking);
		var start = this.button('初始化 AnyGo', function() {
			attempts++;
			starting = true;
			startError = '';
			updateOverlay();
			callSetupStart().then(function(res) {
				if (!res || (res.state !== 'running' && res.state !== 'ready'))
					throw new Error('Unable to start setup');
				state = res.state === 'ready' ? 'checking' : 'running';
			}).catch(function() {
				startError = '无法启动初始化。请确认当前账号有初始化权限后重试。';
			}).finally(function() {
				starting = false;
				updateOverlay();
				refresh();
			});
		}, { class: 'anygo-button anygo-button-primary', hidden: '' });
		var overlay = E('div', {
			class: 'anygo-setup-overlay', role: 'region', 'aria-labelledby': 'anygo-setup-title', tabindex: '-1'
		}, E('section', { class: 'anygo-panel anygo-setup-panel' }, [ title, message, start ]));
		var root = E('div', { class: this.themeClass() + ' anygo-worker-guard' }, [ content, overlay ]);

		function updateOverlay() {
			var ready = state === 'ready';
			var focus = document.activeElement;
			content.inert = !ready;
			overlay.hidden = ready;
			if (ready) {
				if (overlay.contains(focus))
					content.focus();
				return;
			}
			title.textContent = starting || state === 'running' ? '正在初始化 AnyGo' : '初始化 AnyGo';
			message.textContent = startError || setupMessages[starting ? 'running' : state];
			start.hidden = state !== 'required' && state !== 'failed';
			start.disabled = starting;
			start.textContent = state === 'failed' ? '重试初始化' : '初始化 AnyGo';
			if (content.contains(focus) || (focus === start && start.hidden))
				overlay.focus();
		}

		function refresh() {
			if (checking || starting)
				return Promise.resolve();
			checking = true;
			var attempt = attempts;
			return callSetupStatus().then(function(res) {
				if (attempt !== attempts)
					return;
				var next = res && res.state;
				if (next === 'ready' && !rendered) {
					return Promise.resolve(renderPage()).then(function(page) {
						content.replaceChildren(page);
						rendered = true;
						state = 'ready';
						updateOverlay();
					});
				}
				if (next !== state)
					startError = '';
				state = next === 'ready' || setupMessages[next] ? next : 'unavailable';
				updateOverlay();
			}).catch(function() {
				if (attempt === attempts) {
					startError = '';
					state = 'unavailable';
					updateOverlay();
				}
			}).finally(function() {
				checking = false;
				if (attempt !== attempts && !starting)
					refresh();
			});
		}

		poll.add(refresh, 3);
		refresh();
		return root;
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
