class TokenStore:
    def __init__(self):
        self.value = None

    def save(self, value):
        self.value = value

    def read(self):
        return self.value
