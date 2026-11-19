PREFIX ?= /usr/local
BINDIR  = $(PREFIX)/bin
NAME    = faradia

.PHONY: install uninstall

install: bin/$(NAME)
	install -d $(DESTDIR)$(BINDIR)
	install -m 755 bin/$(NAME) $(DESTDIR)$(BINDIR)/$(NAME)
	@echo "Installed $(NAME) → $(DESTDIR)$(BINDIR)/$(NAME)"

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/$(NAME)
	@echo "Removed $(DESTDIR)$(BINDIR)/$(NAME)"
