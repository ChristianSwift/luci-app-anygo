'use strict';
'require view';
'require rpc';
'require poll';
'require anygo.common as common';

var callLogs = rpc.declare({ object: 'anygo', method: 'get_logs' });

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		common.loadStyles();
	},

	render: function() {
		return common.guardWorker(L.bind(this.renderPage, this));
	},

	renderPage: function() {
		var status = E('span', { class: 'anygo-muted', role: 'status' }, '加载中…');
		var rows = E('div', { id: 'anygo-logs', class: 'anygo-log-scroll', tabindex: '0', 'aria-label': '日志列表' });
		var fingerprint;
		var refresh = function() {
			return callLogs().then(function(res) {
				if (!res || !Array.isArray(res.lines))
					throw new Error('日志读取失败');
				var lines = res.lines.slice(-120).reverse();
				var next = JSON.stringify(lines);
				status.textContent = lines.length ? '最近 ' + lines.length + ' 条' : '';
				if (next === fingerprint)
					return;
				fingerprint = next;
				var entries = lines.map(function(line) {
					var level = String(line.level || '').toUpperCase();
					return E('div', { class: 'anygo-log-row' }, [
						E('time', {}, new Date(line.ts * 1000).toLocaleTimeString()),
						E('span', { class: 'anygo-log-level anygo-log-level-' + level.toLowerCase() }, level),
						E('div', {}, [
							E('span', {}, line.msg),
							line.udid ? E('span', { class: 'anygo-log-device' }, line.udid) : ''
						])
					]);
				});
				rows.replaceChildren.apply(rows, entries.length ? entries : [
					E('p', { class: 'anygo-empty' }, '暂无日志')
				]);
			}).catch(function() {
				status.textContent = '日志读取失败，正在重试…';
			});
		};

		poll.add(refresh, 3);
		return E('div', { class: common.themeClass() + ' anygo-logs-page' }, [
			E('div', { class: 'anygo-heading anygo-heading-split' }, [ E('h2', {}, '运行日志'), status ]),
			E('section', { class: 'anygo-panel anygo-log-panel' }, [
				E('div', { class: 'anygo-log-header' }, [ E('span', {}, '时间'), E('span', {}, '级别'), E('span', {}, '消息') ]),
				rows
			])
		]);
	}
});
