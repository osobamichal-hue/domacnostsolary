package cz.homeapp.android

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.snackbar.Snackbar
import cz.homeapp.android.databinding.ActivitySetupBinding

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: ServerPrefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = ServerPrefs(this)

        binding.editInternalHost.setText(prefs.getInternalHost())
        binding.editInternalPort.setText(prefs.getInternalPort())
        binding.editPublicHost.setText(prefs.getPublicHost())
        binding.editPublicPort.setText(prefs.getPublicPort())
        binding.switchPreferInternal.isChecked = prefs.isPreferInternalFirst()
        binding.switchRemember.isChecked = prefs.isRememberLogin()
        binding.editUsername.setText(prefs.getUsername())

        binding.btnSave.setOnClickListener { saveAndFinish() }
        binding.btnCancel.setOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    private fun saveAndFinish() {
        val internalHost = binding.editInternalHost.text?.toString() ?: ""
        val internalPort = binding.editInternalPort.text?.toString() ?: ""
        val publicHost = binding.editPublicHost.text?.toString() ?: ""
        val publicPort = binding.editPublicPort.text?.toString() ?: ""

        val hasInternal = UrlBuilder.buildBaseUrl(internalHost, internalPort).isNotEmpty()
        val hasPublic = UrlBuilder.buildBaseUrl(publicHost, publicPort).isNotEmpty()
        if (!hasInternal && !hasPublic) {
            Snackbar.make(binding.root, R.string.error_need_server, Snackbar.LENGTH_LONG).show()
            return
        }

        val username = binding.editUsername.text?.toString() ?: ""
        val passwordInput = binding.editPassword.text?.toString() ?: ""
        val remember = binding.switchRemember.isChecked

        val passwordNew: String? = when {
            !remember -> null
            passwordInput.isNotEmpty() -> passwordInput
            prefs.getCredentialsJsonOrNull() != null -> null
            else -> {
                Snackbar.make(
                    binding.root,
                    "Pro automatické přihlášení vyplňte uživatelské jméno i heslo.",
                    Snackbar.LENGTH_LONG
                ).show()
                return
            }
        }

        if (remember && username.isBlank()) {
            Snackbar.make(
                binding.root,
                "Vyplňte uživatelské jméno nebo vypněte automatické přihlášení.",
                Snackbar.LENGTH_LONG
            ).show()
            return
        }

        prefs.save(
            internalHost = internalHost,
            internalPort = internalPort,
            publicHost = publicHost,
            publicPort = publicPort,
            preferInternal = binding.switchPreferInternal.isChecked,
            username = username,
            passwordNew = passwordNew,
            remember = remember
        )
        setResult(RESULT_OK)
        finish()
    }
}
