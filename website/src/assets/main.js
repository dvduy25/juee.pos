const icons = {
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  phone: '<path d="M21 16.5v3a2 2 0 0 1-2.2 2A18 18 0 0 1 2.5 5.2 2 2 0 0 1 4.5 3h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 2l-1.2 1.2a14 14 0 0 0 4.9 4.9l1.2-1.2a2 2 0 0 1 2-.6l3 .5a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  facebook: '<path d="M14 21v-8h3l.5-4H14V7c0-1 .5-2 2-2h2V2h-3c-3 0-5 2-5 5v2H7v4h3v8"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
  play: '<path d="m8 5 11 7-11 7V5z"/>',
  utensils: '<path d="M4 3v6a3 3 0 0 0 6 0V3M7 3v18M20 3c-3 2-5 5-5 9h5m0-9v18"/>',
  store: '<path d="M3 10V8l2-4h14l2 4v2M3 10a3 3 0 0 0 4.5 2.6 3 3 0 0 0 4.5-1.2 3 3 0 0 0 4.5 1.2A3 3 0 0 0 21 10M5 13v7h14v-7M10 20v-5h4v5"/>',
  coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9zM16 10h2a3 3 0 1 1 0 6h-2M3 21h18M8 3v3m4-3v3"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  bed: '<path d="M3 18v-8m18 8v-5a2 2 0 0 0-2-2H3m0 5h18M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M12 6v5"/>',
  ticket: '<path d="M4 6h16a1 1 0 0 1 1 1v2a3 3 0 0 0 0 6v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a3 3 0 0 0 0-6V7a1 1 0 0 1 1-1zM14 6v2m0 3v2m0 3v2"/>',
  chart: '<path d="M4 4v16h16M8 16l4-5 3 2 5-7"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9m-4-15.7 8 4.5"/>',
  receipt: '<path d="M6 3l2 2 2-2 2 2 2-2 2 2 2-2v18l-2-2-2 2-2-2-2 2-2-2-2 2zM9 9h6m-6 4h6"/>',
  scan: '<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8m-6-4h4m-4 8h4"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m4 9v-2a4 4 0 0 0-3-3.9"/>'
};

function setIcon(element, name) {
  element.dataset.icon = name;
  element.innerHTML = '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">' + icons[name] + '</svg>';
}
document.querySelectorAll('[data-icon]').forEach(element => setIcon(element, element.dataset.icon));

const models = {
  restaurant: {
    name: 'Nhà hàng', icon: 'utensils', title: 'Từ bàn ăn đến bếp, cùng một đơn.',
    description: 'Phục vụ ghi món theo bàn, bếp xác nhận món đã ra và thu ngân kiểm tra trước khi chốt hóa đơn.',
    features: ['Gọi món tại bàn bằng mã QR', 'Xếp món bếp theo thứ tự gọi', 'Thanh toán ngay trong danh sách món đã gọi'],
    screen: 'Màn hình bếp', action: 'Xác nhận món đầu đã ra',
    rows: [['Bàn 04 · Bò sốt tiêu đen', '2 phần · Gọi lúc 11:42', 'Đang chờ', 'warning'],
      ['Bàn 02 · Cơm chiên hải sản', '1 phần · Gọi lúc 11:45', 'Đang chờ', 'warning'],
      ['Bàn 06 · Salad cá hồi', '1 phần · Gọi lúc 11:36', 'Đã ra món', 'success']],
    result: ['Đã ra món', 'Bếp đã xác nhận món của bàn 04.']
  },
  retail: {
    name: 'Bán lẻ', icon: 'store', title: 'Bán tại quầy, đối chiếu được tồn kho.',
    description: 'Tìm hoặc quét mã vạch để thêm sản phẩm vào giỏ. Hệ thống ghi hóa đơn và cập nhật tồn sau giao dịch.',
    features: ['Khuyến mãi theo sản phẩm hoặc toàn đơn', 'Tự động trừ tồn khi bán', 'Theo dõi kiểm kê và hạn sử dụng theo lô'],
    screen: 'Hóa đơn tại quầy', action: 'Xác nhận đã thu 117.000 ₫',
    rows: [['Đơn tại quầy · 117.000 ₫', '3 sản phẩm · Giảm giá 10.000 ₫', 'Chưa thu', 'warning'],
      ['Cà phê hạt rang · 2 gói', '49.000 ₫ mỗi gói', 'Trong giỏ', 'neutral'],
      ['Giấy lọc cà phê · 1 hộp', '29.000 ₫ mỗi hộp', 'Trong giỏ', 'neutral']],
    result: ['Đã thanh toán', 'Hóa đơn và số tồn đã cập nhật trong demo.']
  },
  cafe: {
    name: 'Quán nước', icon: 'coffee', title: 'Ghi món tại quầy, chuyển thẳng đến pha chế.',
    description: 'Theo dõi đồ uống khách gọi tại bàn hoặc mang đi. Quầy pha chế xem món nào gọi trước và xác nhận khi đã phục vụ.',
    features: ['Gọi món tại bàn hoặc mang đi', 'Theo dõi thời gian chờ món', 'Đánh dấu hết món theo chi nhánh'],
    screen: 'Quầy pha chế', action: 'Xác nhận đồ uống đã ra',
    rows: [['Mang về · Bạc xỉu đá', '2 ly · Gọi lúc 08:15', 'Đang pha', 'warning'],
      ['Bàn 02 · Trà đào cam sả', '1 ly · Gọi lúc 08:17', 'Đang chờ', 'warning'],
      ['Bàn 01 · Cà phê sữa đá', '1 ly · Gọi lúc 08:12', 'Đã phục vụ', 'success']],
    result: ['Đã phục vụ', 'Đơn mang về đã được cập nhật.']
  },
  members: {
    name: 'Hội viên', icon: 'activity', title: 'Check-in nhanh, biết ngay gói còn hạn.',
    description: 'Lễ tân tra cứu hồ sơ, ảnh đại diện, hạn gói và số lượt còn lại. Mỗi lượt vào được ghi thời gian.',
    features: ['Gói theo thời hạn hoặc số lượt', 'Lịch sử check-in theo hội viên', 'Liên kết mã với thẻ hoặc thiết bị đã tích hợp'],
    screen: 'Quầy tiếp đón', action: 'Check-in hội viên Mai',
    rows: [['Trần Ngọc Mai', 'Gói 10 lượt · Còn 3 lượt', 'Đủ điều kiện', 'neutral'],
      ['Nguyễn Minh Anh', 'Gói tháng · Đã vào lúc 07:35', 'Đã check-in', 'success'],
      ['Lê Hoàng Nam', 'Gói tháng · Còn 8 ngày', 'Còn hạn', 'neutral']],
    result: ['Đã check-in', 'Check-in thành công. Hội viên còn 2 lượt.', 'Gói 10 lượt · Còn 2 lượt']
  },
  hotel: {
    name: 'Khách sạn', icon: 'bed', title: 'Đặt trước hoặc check-in ngay tại quầy.',
    description: 'Lễ tân xem sơ đồ phòng và nhận khách theo giờ, combo hoặc qua đêm. Với phòng theo giờ, tiền phòng tính theo thời gian ở thực tế.',
    features: ['Đặt trước theo ngày và giờ khách đến', 'Theo dõi phòng đang ở, quá giờ và chờ dọn', 'Cộng phụ phí và in phiếu thu'],
    screen: 'Lễ tân · Trả phòng', action: 'Tính tiền 2 giờ 10 phút',
    rows: [['Phòng 203 · Khách trả phòng', 'Nhận lúc 13:00 · Trả lúc 15:10', 'Chờ tính tiền', 'warning'],
      ['Giờ đầu', '100.000 ₫', '1 giờ', 'neutral'],
      ['Mỗi giờ tiếp theo', '50.000 ₫ mỗi giờ · Làm tròn lên', '2 giờ', 'neutral']],
    result: ['200.000 ₫', 'Tiền phòng là 200.000 ₫, tính theo 3 giờ.']
  },
  tickets: {
    name: 'Thu vé', icon: 'ticket', title: 'Bán vé ở quầy, soát vé bằng mã QR.',
    description: 'Thiết lập loại vé, giá và khung giờ vào cửa. Nhân viên quét mã để ghi nhận lượt sử dụng.',
    features: ['Cấu hình sức chứa và giá mua sớm', 'Phát hành và in vé QR', 'Tra cứu lịch sử bán và lượt vào'],
    screen: 'Soát vé', action: 'Soát vé JU-0241',
    rows: [['JU-0241 · Vé người lớn', 'Khung giờ 08:00 đến 17:00', 'Chưa sử dụng', 'neutral'],
      ['JU-0240 · Vé trẻ em', 'Đã vào lúc 09:12', 'Đã soát', 'success'],
      ['JU-0239 · Vé người lớn', 'Đã vào lúc 09:09', 'Đã soát', 'success']],
    result: ['Đã soát', 'Đã ghi nhận lượt vào cho vé JU-0241.']
  }
};

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const panel = document.getElementById('model-demo');
const demoButton = panel.querySelector('.demo-action');
const demoFeedback = panel.querySelector('output');
let activeTab = tabs[0];
let complete = false;

function demoRow([title, description, state, tone]) {
  const row = document.createElement('li');
  const detail = document.createElement('div');
  const primary = document.createElement('strong');
  const secondary = document.createElement('small');
  const status = document.createElement('span');
  primary.textContent = title;
  secondary.textContent = description;
  status.textContent = state;
  status.className = 'status ' + tone;
  detail.append(primary, secondary);
  row.append(detail, status);
  return row;
}

function activateTab(tab) {
  if (tab === activeTab) return;
  activeTab.tabIndex = -1;
  activeTab.setAttribute('aria-selected', 'false');
  tab.tabIndex = 0;
  tab.setAttribute('aria-selected', 'true');
  activeTab = tab;
  const model = models[tab.dataset.model];
  complete = false;
  panel.setAttribute('aria-labelledby', tab.id);
  setIcon(panel.querySelector('.model-icon'), model.icon);
  panel.querySelector('.model-copy h3').textContent = model.title;
  panel.querySelector('.model-copy p').textContent = model.description;
  panel.querySelector('.model-copy ul').replaceChildren(...model.features.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  panel.querySelector('.model-screen-header small').textContent = model.name.toLocaleUpperCase('vi');
  panel.querySelector('.model-screen-header h4').textContent = model.screen;
  panel.querySelector('.demo-rows').replaceChildren(...model.rows.map(demoRow));
  demoButton.textContent = model.action;
  demoFeedback.textContent = '';
  panel.classList.remove('switching');
  void panel.offsetWidth;
  panel.classList.add('switching');
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', event => {
    const destination = {
      ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0, End: tabs.length - 1
    }[event.key];
    if (destination === undefined) return;
    event.preventDefault();
    tabs[destination].focus();
    activateTab(tabs[destination]);
  });
});

demoButton.addEventListener('click', () => {
  const model = models[activeTab.dataset.model];
  const first = panel.querySelector('.demo-rows li');
  const status = first.querySelector('.status');
  const note = first.querySelector('small');
  if (complete) {
    const [, description, initialStatus, tone] = model.rows[0];
    note.textContent = description;
    status.textContent = initialStatus;
    status.className = 'status ' + tone;
    first.classList.remove('updated');
    demoButton.textContent = model.action;
    demoFeedback.textContent = '';
  } else {
    const [label, message, description] = model.result;
    if (description) note.textContent = description;
    status.textContent = label;
    status.className = 'status success';
    first.classList.add('updated');
    demoButton.textContent = 'Thử lại';
    demoFeedback.textContent = message;
  }
  complete = !complete;
});

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
if ('IntersectionObserver' in window && !motion.matches) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -24px 0px', threshold: .08 });
  document.querySelectorAll('.section-heading, .model-tabs, .model, .management-grid article, .faq > div').forEach(element => {
    element.dataset.reveal = '';
    if (element.getBoundingClientRect().top < window.innerHeight) {
      element.classList.add('in-view');
    } else {
      observer.observe(element);
    }
  });
  document.documentElement.classList.add('reveal-ready');
}
