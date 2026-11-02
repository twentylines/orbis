import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { UserModule } from '@/modules/user/user.module';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionManager } from './session.manager';
import { PasskeyStore } from './passkey.store';
import { PasskeyService } from './passkey.service';
import { AccountSecurityService } from './account-security.service';
import { AccountSecurityController } from './account-security.controller';

@Module({
  imports: [UserModule, EncryptionModule, PasswordModule],
  controllers: [AuthController, AccountSecurityController],
  providers: [AuthService, SessionManager, PasskeyStore, PasskeyService, AccountSecurityService],
  exports: [AuthService, PasskeyService, PasskeyStore, SessionManager, AccountSecurityService],
})
export class AuthModule {}
